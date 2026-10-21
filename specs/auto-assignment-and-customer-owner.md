# Spec: Automatic conversation assignment and customer owner

> Ported from deskcomm (round 3 of `docs/status-melhorias-deskcomm.md`):
> the routing worker with `round_robin` / `load` modes
> (`lib/routing/decide.ts`, `lib/routing/eligibility.ts`, PR #1711) and
> the customer owner, "carteira do cliente"
> (`supabase/migrations/20261009161022_0622_carteira_do_cliente.sql`,
> `lib/carteira/aviso-ao-dono.ts`, PR #2667). We reuse the rules and leave
> their plumbing behind: wacrm has no `event_log` queue and no
> `crm_tasks`, and it does have a real presence heartbeat, which deskcomm
> lacks.
>
> Two parts that share one decision point: **A** decides _who answers
> this conversation now_. **B** records _whose customer this is_. B
> feeds A, because the owner is the first candidate, so they ship in
> that order. Each part works without the other.

## Problem

**A. Nobody receives a conversation automatically.** When the AI hands
off and the agent has no `handoff_agent_id`, or the account has no AI,
the conversation sits unassigned in the shared queue. Someone has to
notice it and assign it by hand. With three or more attendants this
gives uneven load, slow first replies, and leads lost at night or at
lunch. The Agius notes (`specs/cliente-agius-credito.md`, "Equipe")
list "distribuição entre vendedores" as a requirement.

**B. The CRM doesn't know whose customer it is.** An owner exists only
on the deal (`deals.assigned_to`) and the conversation
(`conversations.assigned_agent_id`). Both come from whoever touched it
first. Seller A's customer can write to seller B's number, or come back
months later through the queue, and get served by B. Nobody tells A, and
the new deal is created under B or under nobody. Commission goes to the
wrong person, and a dispute has no record of who owned the customer.

## Non-goals

- Skills-based routing (language, product, seniority). Channel
  responsibles (migrations 069/118) already restrict _who may_ take a
  number's conversations, and that is the only filter used here.
- Reassigning conversations that already have an owner. Distribution
  fills only `assigned_agent_id IS NULL`. It never moves a conversation
  from one person to another.
- Auto-unassigning someone who goes offline mid-conversation.
- Per-member work schedules. Deskcomm has them. We use live presence
  instead; see "Eligibility".
- Tasks. Deskcomm notifies the owner by creating a `crm_tasks` row. We
  use a notification, because tasks are a separate backlog item.
- Commission reports by owner. Those belong to the sales-report work.
  Part B only provides the column they will read.
- Backfilling owners. A contact without an owner behaves exactly as
  today.

## Current behavior

**Assignment means "a human took over".** `dispatchInboundToAiReply`
(`src/lib/ai/auto-reply.ts:463`) skips the AI when `assigned_agent_id`
is set. So distribution must **never** assign a conversation the AI is
still handling, or it would silence the bot.

Where an assignee is written today:

| Path                     | File                                            | What it writes                                                                                                                                                  |
| ------------------------ | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AI hand-off              | `handOffToHuman`, `src/lib/ai/auto-reply.ts:97` | `config.handoffAgentId` when set and nobody is assigned; otherwise the conversation stays unassigned and `notifyHandoff` alerts the team                        |
| Flow "hand off" node     | `src/lib/flows/engine.ts:673`                   | `cfg.assign_to` (fixed member), membership-checked                                                                                                              |
| Automation "assign" step | `src/lib/automations/engine.ts:765`             | fixed `agentId`, membership-checked                                                                                                                             |
| Inbox (browser)          | `conversation-list.tsx`, `message-thread.tsx`   | direct `.update()` under RLS. The trigger `enforce_channel_routing_assignment` (069) rejects ineligible members                                                 |
| Reopen                   | `src/lib/conversations/reopen.ts`               | changes only `status`. A reopened conversation **keeps** its last assignee, so deskcomm's "conversation stays with the attendant" option is already our default |

**Notifications:** `notify_conversation_assigned()`
(`086_notifications_v2.sql:211`) already alerts the new assignee. It
labels the actor `human`, `ai` (row in hand-off state) or `rule`, and
`render.test.ts` already has an "automatic distribution" case. So the
alert side of A is already in place.

**Presence:** `member_presence` (024), with a heartbeat every 30s
(`src/components/presence/presence-heartbeat.tsx`). A member is offline
when `last_seen_at` is older than `OFFLINE_AFTER_MS = 75_000`
(`src/lib/presence.ts`), and `away` after 5 minutes idle. Deskcomm had
to remove its presence check because nothing sent heartbeats. Ours is
real, so we can use it.

**Deals:** `deals.assigned_to` references **`profiles(id)`**, not
`auth.users(id)` (`002_pipelines_enhancements.sql:12`, read as
`p.id === deal.assigned_to` in `deal-panel.tsx:117`). Deals are created
from the browser (`deal-quick-create.tsx`, `contact-sidebar.tsx`,
`contact-detail-view.tsx`, `pipeline-settings.tsx`), from automations
(`engine.ts:880`) and from prospecting (`prospecting/activate.ts`).
Because there are many paths, a rule applied in only some of them leaves
gaps. That is the same reason deskcomm used a trigger.

**Contacts:** writable from the browser by any `agent+` under RLS. There
is no owner column.

**Operator mode** (090) rewrites `profiles.account_id` when an operator
switches accounts. A visiting operator therefore _looks like_ an admin
member of the client account while they are inside it.

## Proposed change

### Migration `130_auto_assignment_and_customer_owner.sql`

All DDL is `IF NOT EXISTS`-guarded, with matching assertions added to
`supabase/ci/verify-schema.sql`.

```sql
-- A. settings (one row per account; no row = manual, as today)
CREATE TABLE IF NOT EXISTS assignment_settings (
  account_id     uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  mode           text NOT NULL DEFAULT 'manual'
                 CHECK (mode IN ('manual', 'round_robin', 'least_load')),
  include_away   boolean NOT NULL DEFAULT false,
  prefer_owner   boolean NOT NULL DEFAULT true,   -- part B hook
  owner_on_first_assignment boolean NOT NULL DEFAULT false, -- part B
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid REFERENCES auth.users(id) ON DELETE SET NULL
);

-- A. per-member knobs + round-robin cursor
CREATE TABLE IF NOT EXISTS member_assignment_state (
  account_id        uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id           uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  receives_auto     boolean NOT NULL DEFAULT true,
  capacity          int CHECK (capacity IS NULL OR capacity BETWEEN 1 AND 500),
  last_auto_assigned_at timestamptz,
  PRIMARY KEY (account_id, user_id)
);

-- B. customer owner
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS owner_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS owner_source  text,
  ADD COLUMN IF NOT EXISTS owner_set_at  timestamptz;
-- owner_source IN ('manual','import','first_assignment') or NULL;
-- one-way coherence (owner set ⇒ source and date set), NOT the reverse:
-- ON DELETE SET NULL clears only owner_user_id, and a two-way check
-- would refuse deleting the owner's login (deskcomm hit exactly this).
CREATE INDEX IF NOT EXISTS idx_contacts_owner
  ON contacts(account_id, owner_user_id) WHERE owner_user_id IS NOT NULL;
```

RLS: both new tables can be read by any account member
(`is_account_member(account_id)`, because the inbox shows who receives
distribution) and written by `admin+`.

### Part A: automatic distribution

**Eligibility.** A member is eligible for a conversation when all of
these hold:

1. their `profiles.account_id` is this account, their role is
   `agent`/`admin`/`owner`, and they are **not** a visiting operator
   (they have no `operator_accounts` grant for this account other than
   their home account);
2. `member_assignment_state.receives_auto` is true. A missing row counts
   as true;
3. they pass the number's routing policy. Use the existing
   `routing_policy_for()` (118). No policy means everyone passes; a
   policy with no responsibles means nobody passes, and the conversation
   stays in the queue;
4. presence is `online`, or `away` when `include_away` is on.
   Offline means `last_seen_at < now() - interval '75 seconds'`. This is
   the same constant as `OFFLINE_AFTER_MS`, mirrored in SQL the same
   way role ranking is mirrored, with a comment on both sides;
5. their load is below `capacity` (NULL means no limit). **Load** is the
   number of conversations assigned to them with `status IN ('open',
'pending')` that are not snoozed (`snoozed_until IS NULL OR
snoozed_until <= now()`).

**Pick.** These rules are ported directly from deskcomm's
`selectRoundRobin` / `selectByLoad`:

- `round_robin`: the eligible member with the oldest
  `last_auto_assigned_at` (never assigned comes first), then `user_id`
  as the tiebreak.
- `least_load`: the smallest load wins, and ties are broken by the
  round-robin rule. This keeps the result deterministic.

**One atomic RPC.** `auto_assign_conversation(p_conversation uuid)
RETURNS uuid` is `SECURITY DEFINER`, with `EXECUTE` granted **only** to
`service_role`:

1. `pg_advisory_xact_lock(hashtext('auto_assign:' || account_id))`
   serializes picks per account, so two simultaneous hand-offs can't both
   go to Ana;
2. re-reads the conversation and returns NULL if it is already assigned,
   closed, or the account mode is `manual`;
3. if part B is present and `prefer_owner` is on, and the contact's
   owner is eligible by rules 1–5, picks the owner;
4. otherwise picks by mode;
5. runs `UPDATE conversations SET assigned_agent_id = pick WHERE id = …
AND assigned_agent_id IS NULL`, stamps `last_auto_assigned_at`, and
   returns the pick, or NULL when nobody is eligible.

Doing the pick in SQL instead of TS is deliberate. With TS, supabase-js
gives no transaction between the read and the write. The ordering rule
is still mirrored as a pure TS helper (`src/lib/assignment/pick.ts`)
with unit tests, so the rule is documented and testable, and
`verify-schema.sql` asserts the function exists. Same pattern as
`claim_ai_reply_slot`.

**When it runs** (`src/lib/assignment/auto-assign.ts`, `autoAssign(db,
conversationId)`, never throws, same style as
`runAutomationsForTrigger`):

| Moment                                          | Hook                                                                                                                         | Precedence                                                                                                                                                                                                                              |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AI hands off                                    | `handOffToHuman`, after the hand-off state is written and before `notifyHandoff`                                             | current assignee > `handoff_agent_id` > `autoAssign`. `notifyHandoff` already takes "is someone assigned?", so pass the result through and the "nobody is on it" team alert fires only when distribution found nobody                   |
| Inbound that no bot will answer                 | both webhooks' `after()` fan-out (Meta `webhook/route.ts`, WAHA `webhook/waha/route.ts`), **after** Flows → automations → AI | run only if the conversation is still unassigned **and** the Flows engine did not consume the message **and** no active AI agent will reply (account has no active `ai_configs`, or `ai_autoreply_disabled` is on for the conversation) |
| Flow "hand off" node / automation "assign" step | new option `assign_to: "auto"` / `agentId: "auto"` in both editors                                                           | explicit member > auto                                                                                                                                                                                                                  |
| Nobody was eligible                             | existing cron `GET /api/automations/cron`                                                                                    | each tick, retry `autoAssign` for open, unassigned, non-snoozed conversations in hand-off state or in no-AI accounts whose last inbound was in the last 24h, max 50 per account per tick                                                |

The cron retry replaces deskcomm's requeue with backoff. The cron
already exists, so we need no queue. The 24h cap keeps old threads from
being pushed to people.

**UI.** Settings → Team → new "Distribuição" card, `admin+`:

- mode (Manual / Rodízio / Menor carga) with a one-line explanation of
  each;
- "Incluir quem está ausente" toggle;
- a member table with "Recebe distribuição" toggle, capacity, current
  load and live presence dot.

Inbox: an unassigned conversation in an account with distribution on
shows "Aguardando alguém ficar disponível" in place of the empty
assignee. All strings go in every `messages/*.json` (CI checks parity).

**Capabilities.** One new predicate `canManageDistribution` (admin+) in
`src/lib/auth/roles.ts`, used by the settings route and `RequireRole`.
No open-coded role strings.

**Plan.** Add `distribution` to `PlanFeature`
(`src/lib/billing/entitlements.ts`) for `profissional`+ and to the SQL
`plan_allows` (129). With `essencial` (3 users) the card shows the
"available on" badge, and `autoAssign` returns early. See open questions.

**Audit.** Changing the mode or a member's knobs writes `audit()`
(`assignment.settings_changed`). Individual automatic assignments are
not audited; the notification and `deal_history`-style trail are
enough.

### Part B: customer owner

**Who can set it.** Only `admin+`, and only through the RPC
`set_contact_owner(p_contact uuid, p_owner uuid, p_source text DEFAULT
'manual') RETURNS void`. It is `SECURITY DEFINER`, checks
`is_account_member(contact.account_id, 'admin')` for the caller, and
requires `p_owner` (if not NULL) to be an `agent+` non-operator member
of the same account.

The contacts UPDATE policy doesn't check role, so without a guard an
agent could make themselves owner through PostgREST. A `BEFORE INSERT
OR UPDATE` trigger on `contacts` therefore raises `42501` when
`owner_*` changes and `current_user IN ('authenticated','anon')`. The
RPC and service role pass. This copies deskcomm's 0622 design, which was
written after this exact bypass was demonstrated.

Inside the same transaction the RPC **adopts** the contact's open deals
that have no owner (`status = 'open' AND assigned_to IS NULL`). It
sets `assigned_to` to the owner's **`profiles.id`**; mind the FK. Deals
that already have an owner are not touched, and it writes
`audit('contact.owner_changed', {old, new})`.

**New deals are created with the owner.** A `BEFORE INSERT` trigger on
`deals` fills `assigned_to` with the owner's `profiles.id` when
`assigned_to IS NULL` and the contact has a qualified owner (rule 1 of
eligibility, without presence or capacity). A deal that arrives with an
owner keeps it. This covers all six creation paths at once.

**Owner notice.** New `notification_types` row
`owner_customer_elsewhere` (category `sales`, in-app and push on).
`notifyOwnerIfElsewhere(db, conversationId)` is called from both
webhooks next to the push send, after the idempotency point, so a Meta
retry never notifies twice. It uses deskcomm's
`decidirAvisoDeCarteira` decision as a pure function in
`src/lib/assignment/owner-notice.ts`:

- no qualified owner → nothing;
- conversation unassigned → nothing. Nobody "took" the customer yet, and
  A will prefer the owner anyway;
- assignee is the owner → nothing;
- otherwise → `upsert_notification` to the owner with `group_key =
'owner_elsewhere:' || contact_id`. Repeated messages bump `count`
  instead of creating new rows, which replaces deskcomm's "one open task
  per customer". The body says who is serving the customer and on which
  number, with a link to the conversation.

**Optional automatic ownership.** `owner_on_first_assignment` is off by
default. When on, the first time a contact _without_ an owner gets a
human assignee (manual or automatic), that person becomes the owner with
source `first_assignment`. This is implemented in the same RPC path via
an `AFTER UPDATE OF assigned_agent_id` trigger on `conversations` that
calls the owner-setting logic as definer. It is off by default because
it decides commission silently.

**UI.**

- Contact panel (inbox) and contact view: "Carteira: Ana" chip. Admins
  get a picker, everyone else reads only.
- Contacts list: owner column, plus a "Minha carteira" filter.
- Inbox: a "Minha carteira" filter, meaning conversations whose contact
  I own, whoever is serving them.
- CSV import (`prospecting-csv-import.md` importer): an optional
  "vendedor" column (e-mail of a member) sets the owner with source
  `import`. This is phase 2.

**API v1.** Contacts get `owner_user_id` on read. Writes go through
`PUT /api/v1/contacts/:id/owner`, with a new `contacts:owner` scope,
calling the same RPC. The machine path has no `auth.uid()`, so this
route calls a service-role variant `set_contact_owner_as(p_actor, …)`
after `requireApiKey`, like deskcomm's `p_actor`.

### Delivery order

1. Migration 130 (A tables + B columns, guard trigger, both RPCs, deal
   trigger), `verify-schema.sql`, and the pure helpers with tests.
2. A: `autoAssign` + hand-off hook + webhook hook + cron retry +
   settings UI.
3. B: owner RPC UI (chip/picker), deal trigger live, owner notice.
4. Flow/automation "auto" option, inbox/contacts filters, API v1,
   import column, `owner_on_first_assignment`.

## Acceptance criteria

**A**

- [ ] With mode Manual (and in any account without a settings row),
      nothing changes. The existing tests stay green and no conversation
      is assigned automatically.
- [ ] Round robin: with Ana and Bruno online, three consecutive
      hand-offs go Ana → Bruno → Ana (or Bruno → Ana → Bruno). The order
      is deterministic for a given state.
- [ ] Least load: Ana with 3 open conversations and Bruno with 1 → the
      conversation goes to Bruno. On a tie it falls back to round robin.
- [ ] A snoozed or closed conversation doesn't count toward load.
- [ ] An offline member (no heartbeat for >75s), a member with "Recebe
      distribuição" off, a `viewer`, a visiting operator and a member at
      capacity are never picked.
- [ ] A number with responsibles assigns only among them, and a number
      with an empty responsibles list assigns to nobody.
- [ ] While the AI is answering, distribution never assigns, so the AI
      keeps replying. It assigns only after hand-off, or on inbound in
      accounts with no active AI.
- [ ] When the agent has `handoff_agent_id`, that person still wins.
- [ ] When nobody is eligible, the existing "nobody is on it" team
      notification fires, and the next cron tick after someone comes
      online assigns the conversation.
- [ ] Two simultaneous hand-offs in the same account never go to the
      same person in round robin (advisory lock).
- [ ] The assignee gets the existing "assigned to you" notification with
      the automatic-distribution wording.
- [ ] The plan without `distribution` shows the badge and never
      auto-assigns.
- [ ] `src/lib/assignment/pick.test.ts` covers round robin, least load,
      ties and empty eligibility.

**B**

- [ ] An agent calling `PATCH contacts` with `owner_user_id` through
      PostgREST gets 42501. An admin through the picker succeeds.
- [ ] Setting an owner adopts the contact's open deals without an owner
      and leaves deals with an owner untouched. `deals.assigned_to`
      holds the owner's `profiles.id`.
- [ ] A deal created from any path (quick create, contact sidebar,
      automation, prospecting) for a contact with an owner is created
      with the owner. A deal created with an explicit owner keeps it.
- [ ] A customer owned by Ana writes into a conversation assigned to
      Bruno → Ana gets one notification. Five more messages bump its
      count instead of creating five rows, and a Meta redelivery does
      not notify.
- [ ] With distribution on and `prefer_owner`, an online Ana gets her
      customer's hand-off before the round robin. An offline Ana doesn't
      block it: someone else gets it, and Ana is notified once the
      conversation is assigned to them.
- [ ] Removing Ana from the account (or demoting her to viewer) makes
      her customers behave as if they had no owner. Nothing is assigned
      or notified to her.
- [ ] `owner-notice.test.ts` covers the four outcomes of the decision.
- [ ] i18n parity tests pass with the new strings in every locale.

## Risks / open questions

- **Plan gating.** Is distribution a Profissional+ feature, or included
  in Essencial? Essencial allows 3 users, which is already enough for
  distribution to matter. Recommendation: Profissional+, consistent with
  router and follow-ups. Confirm against `specs/pricing-costs.md` before
  coding, and log the decision there (pricing doc is the living doc).
- **Presence as the only availability signal.** A seller with the app
  open on a laptop at home at 23:00 counts as online. Deskcomm uses work
  schedules instead. We start with presence plus the per-member toggle.
  If this proves wrong, add per-member hours later, reusing the
  account's opening-hours editor from onboarding.
- **Owner offline but preferred.** The current rule falls through to
  someone else when the owner is offline. Some sales teams want "always
  the owner, even offline". This could be a third value of
  `prefer_owner` later. Ask the Agius-type customer before building it.
- **Contact-level owner vs per-number teams.** In a "one WhatsApp per
  seller" setup, the owner and the number's responsibles may disagree.
  Rule 3 (routing policy) wins for _assignment_, because a seller can't
  answer from a number they don't operate. The owner then gets the
  notice. Confirm this is the desired behavior.
- **`deals.assigned_to` → `profiles(id)`.** Every write in B must
  translate user id → profile id. A later cleanup could move the column
  to `auth.users(id)` like appointments (058), but that is out of scope
  here.
- **Hook placement in the webhook (~1200 lines).** The "no bot will
  answer" check must reuse the AI dispatcher's own decision, not
  re-derive it. Prefer having `dispatchInboundToAiReply` return
  `'replied' | 'skipped' | 'handed_off'` and branching on that, so the
  two can't drift.
