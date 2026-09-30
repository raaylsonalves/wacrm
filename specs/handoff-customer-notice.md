# Spec: Tell the customer when the AI hands off, and make the handoff note readable

**Status (2026-09-30): implemented (`src/lib/ai/handoff-notice.ts`).**

> Ported in spirit from deskcomm's `lib/escalacao/aviso-ao-lead.ts`,
> which was written after a measured production failure: the customer
> asked for a person (or answered the AI's own question) and then got
> **silence**. The same defect exists here, in all four handoff paths.
> This is deliberately small and independent of `specs/human-cases.md`
> — fix this first; cases build on top of it.

## Problem

When the AI auto-reply gives up on a conversation, three things go wrong:

1. **The customer is told nothing.** Every path that hands off to a
   human only writes to the database (`ai_autoreply_disabled = true`,
   maybe an assignee, and an internal note). No WhatsApp message goes
   out. From the customer's side: they wrote, the bot answered a few
   times, then went quiet — and it looks like the business ignored them.
   If nobody is assigned (`handoff_agent_id` is `NULL`, the default), the
   conversation also just lands in a shared queue nobody is paged about,
   so the customer may wait indefinitely for a reply they don't know is
   coming from a person.
2. **The internal note is hard-coded English.** `src/lib/ai/handoff.ts`
   builds strings like `🤖 AI agent handed off after 5 replies. Last
   customer message: “…”` on the server and stores the finished sentence
   in `conversations.ai_handoff_summary`. The app is build-time
   single-locale (`NEXT_PUBLIC_APP_LOCALE`, `src/i18n/request.ts`), so a
   Portuguese deployment shows an English sentence inside an otherwise
   Portuguese banner. Reported by the user from a real conversation.
3. **The note is unreadable even when it is in the right language.**
   `src/components/inbox/ai-thread-banner.tsx:146-149` renders it with
   Tailwind `truncate` (one line, ellipsis), so the only information that
   matters — *what the customer last said* and *why the bot stopped* —
   is the part that gets cut off. The full text only exists in a `title`
   tooltip, which does nothing on a phone.

## Non-goals

- **Human Cases** (the AI keeps the conversation and delegates a task to
  a teammate). That is `specs/human-cases.md`. This spec covers the
  "AI leaves" path only.
- **LLM-written handoff summaries.** Keep the summary deterministic (no
  extra token spend, cannot fail, no added latency on the handoff) — the
  existing design goal in `handoff.ts`'s header comment. A richer
  AI-written briefing is a separate follow-up.
- **Business-hours scheduling / SLA promises.** The notice may say "a
  teammate will reply as soon as possible"; it must not promise a time.
- **Per-account editable copy per reason.** One optional account-level
  override is in scope (see below); a full template editor is not.

## Current behavior

- `src/lib/ai/auto-reply.ts:46` `handOffToHuman()` — the single funnel.
  Called from four places:
  - `:208` reply cap reached (early check),
  - `:331` every provider/model tier failed (`AllProvidersFailedError`),
  - `:363` the model asked to hand off, or returned empty text,
  - `:401` lost the atomic `claim_ai_reply_slot` race (cap reached).
  None of them sends a customer message.
- A **fifth**, silent path: `:226-235` — the per-account rate limit
  (`ai-autoreply:${accountId}`) returns without replying *and without
  handing off*, so a burst of inbounds is simply dropped on the floor,
  no note, no banner, no notice. Also `:387-393` (`claim_ai_reply_slot`
  RPC error) returns silently.
- `src/lib/ai/handoff.ts` — `buildHandoffSummary`,
  `buildProviderFailureSummary`, `buildCapReachedSummary`: all English
  literals, all persisted as final text.
- `messages/*.json` `Inbox.messageThread.aiBanner.*` — the banner chrome
  is translated (`pausedTitle` = "O assistente de IA está pausado aqui"),
  the stored note under it is not.
- `member_presence` (migration 024) already tracks who is `online` /
  `away` per account, with `last_seen_at` — usable server-side.
- The 24h WhatsApp session window is open on every one of these paths:
  the code is reacting to an inbound that just landed, so a free-form
  reply is always allowed on the Cloud API (WAHA has no window).

## Proposed change

### 1. Store the *reason*, not the sentence

Migration (next free number at implementation time):

```sql
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS ai_handoff_reason text,
  ADD COLUMN IF NOT EXISTS ai_handoff_meta jsonb,
  ADD COLUMN IF NOT EXISTS ai_handoff_customer_notified boolean,
  ADD COLUMN IF NOT EXISTS ai_handoff_notice_skipped_reason text;

ALTER TABLE conversations
  ADD CONSTRAINT conversations_ai_handoff_reason_check
  CHECK (ai_handoff_reason IS NULL OR ai_handoff_reason IN (
    'model_requested', 'reply_cap', 'provider_failure',
    'empty_reply', 'rate_limited', 'customer_requested_human'
  ));
```

`ai_handoff_meta` carries only structured, non-translated facts:
`{ replyCount, max, lastCustomerMessage, attempts: [{provider, code}] }`.
`ai_handoff_summary` stays (old rows keep working) but new writes leave
it `NULL`; the reader falls back to it when `ai_handoff_reason` is null.
`ai_handoff_reason` is `text` + `CHECK`, not an enum, so a new reason is
a one-line migration (same convention as `channel_routing`/broadcast
statuses in this repo).

`handOffToHuman(db, conversationId, config, assignee, reason, meta)`
replaces the `summary: string` argument. The four existing call sites
pass a reason code + meta; `buildHandoffSummary` & co. are deleted (their
tests become tests of the meta builder).

### 2. Render it localized, and legibly

`ai-thread-banner.tsx` renders from `(reason, meta)` through new
`Inbox.messageThread.aiBanner.handoff.*` keys (all four locales, with the
existing key-parity test enforcing it):

- one short **reason line**, e.g. pt: "O assistente parou após 5 respostas
  (limite da conversa)" / "O cliente pediu um atendente" / "Os provedores
  de IA ficaram indisponíveis";
- the **customer's last message** as a separate quoted block, wrapped
  (`line-clamp-3` + a "ver mais" toggle), not truncated to one line;
- a small chip: "Cliente avisado" / "Cliente NÃO foi avisado (motivo)" —
  the deskcomm lesson: the human who opens the thread must know whether
  the customer is waiting in the dark.

### 3. Send the customer a notice (the actual fix)

New pure module `src/lib/ai/handoff-notice.ts`:

```ts
export function handoffNoticeText(args: {
  reason: HandoffReason;
  contactName: string | null;
  teamOnline: boolean;      // from member_presence, see below
  leadKey: string;          // conversation id — variant picker seed
  locale: string;
  accountOverride?: string | null;
}): string
```

Rules (each is a deskcomm lesson, kept because each has a real failure
behind it):

- **Deterministic and localized**, no LLM. Reads the same message
  dictionary the app uses (`messages/<locale>.json`, like
  `src/lib/push/send.ts`'s `loadLabels`).
- **Reason-aware.** "A teammate will continue with you" is wrong for a
  customer who wrote STOP; the opt-out variant confirms and stops. The
  reason is already known at every call site.
- **Availability-aware.** If `member_presence` shows at least one member
  `online` (last seen within the existing staleness threshold), say a
  teammate will reply shortly; otherwise say the team will reply "assim
  que possível" and that the message was received. Never promise an
  instant response to an empty office.
- **Several variants, chosen by a hash of the conversation id.** Same
  conversation → always the same wording (no flip-flop between retries);
  different conversations → different wording, so a busy account isn't
  sending the identical sentence 200 times, which is exactly what makes a
  WhatsApp number look automated. Variants must differ in structure, not
  just synonyms; a unit test asserts a similarity ceiling across all
  pairs.
- **Optional account override**: `ai_configs.handoff_notice_text`
  (nullable). When set it replaces the default text for every reason
  except opt-out. Length-capped; shown in Settings → AI Assistant with a
  live preview.
- **Sent through the same path as the AI's replies**: `engineSendText`
  (`auto-reply.ts:422`), `aiGenerated: true`, so it is persisted as a
  normal outbound message, respects the WAHA throttle
  (`claim_waha_send_slot`) and appears in the thread.
- **Never blocks or reverses the handoff.** Order: (1) write the handoff
  state, (2) try the notice, (3) record the outcome in
  `ai_handoff_customer_notified` / `ai_handoff_notice_skipped_reason`
  (`send_failed`, `opted_out`, `no_channel`, …). A failed send must not
  leave the conversation half-handed-off — fail closed on the *action*,
  open on the *information*.
- **Not sent when a human already owns the thread**
  (`assigned_agent_id` set) — they are already talking to the customer.
- **Sent at most once per handoff** (guard on
  `ai_handoff_customer_notified IS NULL`), and cleared again when the AI
  is resumed from the inbox so a *later* handoff can notify again.

### 4. Close the two silent paths

- Rate-limited (`:226-235`): hand off with reason `rate_limited` instead
  of returning. The customer message is then visible, flagged, and (if
  configured) assigned — not lost.
- `claim_ai_reply_slot` RPC error (`:387-393`): keep the loud log, but
  also hand off with reason `provider_failure`-class (`system_error`) —
  a deploy problem must not present as "the bot ignores people".

### 5. Tell the team too (uses what already exists)

Assigning already fires `on_conversation_assigned`, which notifies the
assignee. When `handoff_agent_id` is `NULL` nobody is notified. Add: on
handoff with no assignee, fan a push/notification to the account's
`agent`+ members (reusing `sendPushToAccount` from
`specs/pwa-web-push-notifications.md` and the `notifications` table). One
line of copy, deep-linked to the conversation.

## Acceptance criteria

- [ ] After each of the six reasons, the customer receives exactly one
      WhatsApp message in the deployment's locale (unit-tested per
      reason; integration-tested for the model-requested and cap paths).
- [ ] A customer whose message contained an opt-out keyword receives the
      opt-out confirmation and is **not** told a teammate is coming.
- [ ] With nobody `online`, the notice does not promise an immediate
      response.
- [ ] Two different conversations handed off back-to-back get different
      wording; the same conversation always gets the same wording.
- [ ] A failed notice send still leaves the conversation paused/handed
      off, and the inbox chip reads "Cliente NÃO foi avisado" with a
      reason.
- [ ] The banner shows the reason and the customer's last message
      localized and wrapped, on a 375px-wide viewport, with no English
      literal from `handoff.ts` reachable.
- [ ] A burst that trips the per-account rate limit produces handed-off,
      flagged conversations rather than silent drops.
- [ ] Handoff with no assignee notifies the account's agents.
- [ ] Old rows (`ai_handoff_reason IS NULL`, `ai_handoff_summary` set)
      still render.
- [ ] `verify-schema.sql` asserts the new columns and the CHECK.

## Risks / open questions

- **Spam-shaped behavior.** A notice per handoff is a system message the
  customer didn't ask for. It is justified (they wrote in and were
  answered), but the variant + once-per-handoff rules matter — get them
  wrong and the number looks automated.
- **Presence is a heuristic.** `member_presence` says someone has the
  dashboard open, not that they will answer. Wording stays hedged
  ("em breve", not "agora"). A real business-hours model is out of scope.
- **Where does the rate-limit handoff go?** Handing off on every
  rate-limited inbound could pause the bot for the *whole* conversation
  because of an account-wide burst. Alternative: reply-later queue.
  Recommend handing off only that conversation and offering "Retomar IA"
  as today; revisit if bursts are common.
- **Locale for the customer.** The build-time locale is the operator's,
  not necessarily the customer's. For a Brazilian deployment that is the
  right default; multi-language customers are a non-goal.
- **Interaction with cases.** Once `human-cases.md` ships, "the AI
  cannot resolve X" should *open a case and keep talking* instead of
  handing off. This notice remains the fallback for the cases that do
  hand off (opt-out, cap, provider outage).
