# Spec: Follow-up sequences (don't let a conversation go cold)

> Supersedes `specs/ai-conversation-followup-on-silence.md` (which
> proposed a single nudge and explicitly ruled out sequences). Ported in
> spirit from deskcomm's follow-up system (`followup_flow_*` +
> `followup_enrollments`, the "silence sweep"), but built **on top of the
> automations engine wacrm already has** instead of a second engine —
> deskcomm's own plan needed four new tables and a graph editor; here the
> builder, durable waits and cron already exist and only the parts that
> are genuinely missing get added.

## Problem

A lead who stops answering is a lost sale nobody notices. Today:

- The AI/bot and humans only ever **react** to inbound messages. Nothing
  fires on the *absence* of one (`src/lib/ai/auto-reply.ts` runs from the
  webhook's `after()`; there is no code path for "N hours passed").
- The automations engine has a durable `Wait` step, but no trigger for
  "this conversation went silent", so a follow-up sequence can't start.
- Worse, a `Wait` that is already parked **cannot be cancelled**:
  `automation_pending_executions.status` is `pending|running|done|failed`
  (migration 006), and nothing marks a parked wait dead when the customer
  finally replies, is assigned to a human, opts out, or the conversation
  is closed. A naive "wait 1 day, then nudge" automation would happily
  message a customer who answered five minutes after it was armed. **This
  missing stop condition is the reason follow-ups can't safely be built
  from today's parts.**

## Non-goals

- Cold outreach / prospecting lists — see `specs/prospecting-csv-import.md`
  (it can *use* sequences later, but it has its own consent problems).
- LLM-authored follow-ups. v1 uses fixed text with rotating variants and
  `{{name}}`; a contextual AI-written nudge is a v2 (it doubles token
  spend on every idle conversation).
- Per-recipient timezone or "best time to send" optimization.
- A new visual editor. Sequences are edited in the existing automation
  builder (`src/components/automations/automation-builder.tsx`).
- Following up on conversations where the customer is waiting on *us* —
  that is the response-time SLA (`src/lib/inbox/sla.ts`), a different
  problem with a different owner.

## Current behavior

- `src/types/index.ts:530` `AutomationTriggerType`: `new_message_received`,
  `first_inbound_message`, `keyword_match`, `new_contact_created`,
  `conversation_assigned`, `tag_added`, `time_based` (a cron `schedule`,
  not per-conversation silence), `interactive_reply`.
- `src/lib/automations/engine.ts:319-345` — a `wait` step inserts an
  `automation_pending_executions` row (`context` carries
  `conversation_id`) and stops; `GET /api/automations/cron` claims due
  rows (`pending → running`, stale-`running` reclaim) and resumes.
  Nothing re-checks the world at resume time.
- `conversations.last_message_at` and `last_message_sender_type`
  (`customer|agent|bot`, migration 051) already say "who spoke last and
  when" — enough to *detect* silence without new tracking columns.
  There is **no** `last_customer_message_at`.
- `bump_conversation_on_inbound` (migration 037 → 051 → 070) is the single
  SQL funnel both inbound webhooks (Meta + WAHA) call.
- Status and assignment changes are written **from the browser** through
  RLS (`conversation-list.tsx`, `message-thread.tsx`), so no server hop
  sees them — the same constraint that put channel-routing enforcement in
  a Postgres trigger (migration 069).
- `contacts.opted_out_at` (migration 053) exists; the webhooks set it on
  STOP keywords.
- Cloud API free-form messages are only allowed within 24h of the
  customer's last message; WAHA has no such window.

## Proposed change

### 1. Schema (migration, next free number)

```sql
-- Episode anchor: a new silence "episode" begins only when the
-- customer speaks again. Follow-ups we send must NOT restart the clock
-- (they change last_message_at), or the sweep would re-enroll forever.
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS last_customer_message_at timestamptz;
-- backfill from messages (customer rows), then maintained by
-- bump_conversation_on_inbound (below).

ALTER TABLE automations
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'automation'
    CHECK (kind IN ('automation', 'followup'));

CREATE TABLE IF NOT EXISTS followup_enrollments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  automation_id uuid NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  episode_at timestamptz NOT NULL,          -- = last_customer_message_at
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'completed', 'cancelled')),
  outcome text CHECK (outcome IN
    ('replied','exhausted','handoff','opted_out','closed','window_closed')),
  steps_sent smallint NOT NULL DEFAULT 0,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  -- The unique key IS the claim: one enrollment per (sequence,
  -- conversation, episode). INSERT ... ON CONFLICT DO NOTHING RETURNING
  -- is how two overlapping sweeps avoid double-enrolling.
  UNIQUE (automation_id, conversation_id, episode_at)
);
CREATE INDEX IF NOT EXISTS idx_followup_enrollments_active
  ON followup_enrollments (conversation_id) WHERE status = 'active';

ALTER TABLE automation_pending_executions
  ADD COLUMN IF NOT EXISTS enrollment_id uuid
    REFERENCES followup_enrollments(id) ON DELETE CASCADE;
-- widen the CHECK to allow 'cancelled' (drop + re-add the constraint).
```

RLS on `followup_enrollments`: `SELECT` for `is_account_member`, writes
service-role only (same shape as `audit_log`).

`bump_conversation_on_inbound` is `CREATE OR REPLACE`d **again** to set
`last_customer_message_at = NOW()` and to cancel the conversation's
active enrollments with outcome `replied` (see §3). ⚠ It must be copied
from the **latest** body (migration 070, which also clears
`snoozed_until`); copying an older version would silently un-fix
un-snooze. `verify-schema.sql` asserts the function text still contains
both `snoozed_until` and `last_customer_message_at`.

### 2. New trigger: `conversation_silence`

`AutomationTriggerType` gains `conversation_silence`;
`trigger_config`:

```ts
{
  silence_after: { amount: number; unit: 'minutes' | 'hours' | 'days' };
  audience: 'ai_conversations' | 'all_open';   // default ai_conversations
  max_age_days: number;      // ignore conversations idle longer, default 14
  send_window?: { start_hour: number; end_hour: number; tz: string;
                  days?: number[] };            // when steps may send
  handoff_policy: 'cancel' | 'pause' | 'allow'; // default cancel
}
```

`src/lib/automations/trigger-meta.ts`, `validate.ts` (a `followup` must
have ≥1 send step; `silence_after` ≥ 5 minutes), the builder's trigger
picker and the MCP `write.ts` trigger enums all gain the new value (they
each hard-code the list today — grep for `'time_based'`).

**Sweep** (`src/lib/automations/followup-sweep.ts`), called from the
existing `GET /api/automations/cron` so a deployment does **not** need a
second external pinger:

1. For each active `kind = 'followup'` automation, select conversations
   with `status IN ('open','pending')`, `last_message_sender_type IN
   ('agent','bot')`, `last_customer_message_at IS NOT NULL`,
   `last_message_at <= now() - silence_after`, `last_message_at >=
   now() - max_age`, plus the audience filter (`assigned_agent_id IS
   NULL AND ai_autoreply_disabled = false` for `ai_conversations`),
   `contacts.opted_out_at IS NULL`, not snoozed, bounded batch (e.g. 200
   per run, oldest first).
2. `INSERT INTO followup_enrollments ... ON CONFLICT DO NOTHING
   RETURNING id` — a returned row means *this* run won the claim; run the
   sequence's first step via the existing engine entry
   (`runAutomationsForTrigger` path / `resumePendingExecution`), passing
   `enrollment_id` in `context`.
3. Never throws (same contract as `runAutomationsForTrigger`).

### 3. Stop conditions (the important part)

One function, `cancelFollowups(db, { conversationId, reason })`, that:
`UPDATE followup_enrollments SET status='cancelled', outcome=$reason,
ended_at=now() WHERE conversation_id=$1 AND status='active'` and
`UPDATE automation_pending_executions SET status='cancelled' WHERE
enrollment_id IN (...) AND status='pending'`.

It is invoked from **three layers**, because no single one is enough:

- **SQL, on inbound** — inside `bump_conversation_on_inbound` (reason
  `replied`). This covers both webhooks with one edit.
- **SQL triggers, for writes that come from the browser** — `AFTER UPDATE
  OF status, assigned_agent_id ON conversations`: `status = 'closed'` →
  `closed`; assignment to a human → `handoff` when the sequence's
  `handoff_policy = 'cancel'`. And `AFTER UPDATE OF opted_out_at ON
  contacts` → `opted_out` for that contact's conversations.
- **At send time, as the source of truth** — before *every* send step of
  a follow-up run, `shouldStillSend(enrollment)` re-reads the row:
  enrollment still `active`, `last_customer_message_at = episode_at` (the
  customer hasn't spoken since), contact not opted out, conversation not
  closed/snoozed, within the send window. If false: end the enrollment
  with the matching outcome and do **not** send. Triggers are cleanup;
  this check is what makes a race harmless.

### 4. Send-time guards inside a follow-up run

- **24h window (Cloud API).** If `now - last_customer_message_at > 24h`,
  only `send_template` steps may go out; a free-form step is skipped and
  the enrollment ends `window_closed` (logged, never attempted — a doomed
  send to Meta is noise). WAHA channels skip this check.
- **Send window.** If a `wait` resumes outside `send_window`, reschedule
  to the next window start instead of sending at 3am or dropping it.
- **Per-contact frequency cap.** Across *all* sequences, at most N
  follow-up messages per contact per 7 days (default 3, account-level
  setting) — two overlapping sequences must not double-nudge.
- **Rotating variants.** `send_message` config gains optional
  `variants: string[]`, picked by a hash of the conversation id (same
  approach as `specs/handoff-customer-notice.md`): identical bodies sent
  to many customers are what makes a number look automated. `{{name}}`
  substitution reuses the existing variable mechanism.
- **WAHA numbers** go through `claim_waha_send_slot` like every other
  send (the engine's send helpers already do), so a burst of due
  follow-ups can't blow the anti-ban throttle.

### 5. UI

- Automations list shows a **Follow-up** badge for `kind = 'followup'`,
  and the "new automation" flow offers "Follow-up de silêncio" as its own
  starting point (`src/lib/automations/templates.ts` already has the
  template registry — add a ready-made "3 toques em 3 dias": silence 4h →
  message → wait 1 day → message → wait 2 days → message + tag
  `sem-resposta`).
- Automation detail/logs gains a small funnel: *enrolled → replied /
  exhausted / cancelled(by reason)*, from `followup_enrollments`.
- Conversation thread: a one-line chip "Follow-up 2/3 agendado para
  amanhã 10:00 · Cancelar" so an agent can see and stop it (cancel =
  `cancelFollowups` with reason `handoff`).
- Settings → AI Assistant: replaces the old spec's toggle with a link to
  the template ("Ativar follow-up para leads da IA").

### 6. i18n

All copy in the four locales (`Automations.*`, `Inbox.*`); the
key-parity test enforces it.

## Acceptance criteria

- [ ] A conversation the bot/agent spoke last in, silent past
      `silence_after`, is enrolled **exactly once per episode**; running
      the sweep twice concurrently creates one enrollment.
- [ ] A customer reply at any point cancels the remaining steps — proven
      for (a) reply while a wait is parked, (b) reply landing between the
      cron claiming the wait and the send (the send-time check catches it).
- [ ] Assigning to a human (with `handoff_policy = 'cancel'`), closing the
      conversation, or opting out — each performed **from the browser
      client path**, not an API route — cancels pending steps.
- [ ] Our own follow-up messages never start a new episode (no
      re-enrollment loop after the sequence is exhausted).
- [ ] Outside 24h on the Cloud API, a free-form step is skipped with
      outcome `window_closed`; a template step still sends.
- [ ] Steps due at night are deferred to the send window, not sent.
- [ ] No contact receives more than the frequency cap across sequences.
- [ ] Two conversations get different wording from `variants`; the same
      conversation always gets the same one.
- [ ] `automation_pending_executions` rows that were `pending` before the
      migration keep working (the CHECK widening is additive).
- [ ] `verify-schema.sql` asserts the tables, the widened CHECK, the
      `UNIQUE` key and the redefined `bump_conversation_on_inbound`.
- [ ] Unit tests: sweep selection predicate, `shouldStillSend` truth
      table, window rescheduling math, cap logic, variant hashing.

## Risks / open questions

- **Cron cadence.** Sequences tolerate minutes of jitter, but the
  existing cron's real cadence is whatever the operator's pinger is set
  to (`docs/deploy-vercel.md`). Document a recommended 5-minute ping.
- **Trigger scope creep on `conversations`.** Two new triggers fire on
  every status/assignment write. They are cheap (`WHERE status='active'`
  partial index) but are on a hot table — measure before merging.
- **Deal-based stop.** Stopping when the contact's deal moves to "won"
  is natural but couples this to pipelines; left out of v1, flagged.
- **Follow-ups to non-responders are the riskiest thing a WhatsApp
  number can do.** On WAHA (unofficial) a burst of unsolicited nudges is
  a ban vector; on the Cloud API it is a template-quality problem. The
  frequency cap and send window are guardrails, not guarantees — default
  every new follow-up to **inactive** and show a one-line risk note on
  activation.
- **Old spec.** Add a "Superseded by `followup-sequences.md`" note at the
  top of `ai-conversation-followup-on-silence.md`; its two columns
  (`ai_awaiting_reply_since`, `ai_followup_sent_at`) are **not** created.
- **Cost of `audience: all_open`.** Including human-owned conversations
  is what deskcomm allows behind `handoff_policy`; default stays
  AI-only to match the old spec's caution.
