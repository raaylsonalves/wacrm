# Spec: Human Cases (the AI keeps the customer, a teammate does the task)

> Ported from deskcomm's "Casos Humanos"
> (`docs/specs/15-spec-casos-humanos.md`, migration `0066_human_cases`).
> Not a replacement for `specs/handoff-customer-notice.md` — they solve
> different situations (see Problem). Larger than most specs here;
> delivered in the phases listed at the end.

## Problem

Today the AI has exactly one way out of a conversation it can't finish:
**hand off**. That is a one-way door — `handOffToHuman()`
(`src/lib/ai/auto-reply.ts:46`) pauses the bot on that thread until a
person clicks "Retomar IA", and the human has to take over the whole
conversation, even when all that's needed is one back-office action
("free the customer's access", "check the refund in the payment tool",
"confirm the stock with the warehouse").

Two distinct situations get conflated:

| Situation | Right tool |
|---|---|
| The AI should **step aside** (customer asked for a person, opted out, AI outage, reply cap) | Handoff — and the customer must be **told** (`handoff-customer-notice.md`) |
| The AI should **stay** and get a *task* done by someone else, then report back | **Case** (this spec) |

A case is the AI saying "I can't do this myself, but I'll keep talking to
the customer while a teammate does it." The teammate talks **to the AI**,
not to the customer; the AI relays the outcome. The customer sees one
consistent voice and never gets dropped.

The user asked whether cases would fix the "AI gave up and said nothing"
problem. **Partly**: cases prevent many handoffs by keeping the AI in
charge of delegable work, but a handoff will still happen (opt-out, cap,
provider outage), so the notice spec stays necessary and ships first.

## Non-goals

- A teammate chatting with the customer *through* a case — that is a
  handoff; the human takes the thread.
- SLA timers, escalation ladders, categories, priorities, assignment
  rules beyond "who is notified". v1 is a small state machine.
- Automated reminder messages to a customer who is slow to provide info.
  That is `specs/followup-sequences.md`; here an unresponsive customer
  only raises a flag for the human.
- Voice/calls, attachments on cases (v2).
- Multi-agent routing of cases by topic.

## Current behavior

- Model-requested handoff is a signal on the generation result
  (`generate.ts` → `handoff: boolean`, consumed at
  `auto-reply.ts:363`); there is no tool for it and nothing else the model
  can *do* to get help.
- AI tools live in `src/lib/ai/tools/`: `CONTACT_TOOLS` +
  `createContactToolExecutor` (`contact.ts`, always on) and `AGENDA_TOOLS`
  + `createAgendaToolExecutor` (`agenda.ts`, opt-in via
  `config.agendaEnabled`). Executors take a context built from the *real*
  turn (`db`, `accountId`, `conversationId`, `contactId`) and return
  `{"error": …}` strings instead of throwing — the exact shape cases need.
  They are wired at `auto-reply.ts:282-300`.
- `notifications.type` is `CHECK (type IN ('conversation_assigned'))`
  (migration 027) — one value.
- `sendPushToAccount` / `pushInboundMessage` (`src/lib/push/send.ts`)
  can page the team; `channel_routing_responsibles` (migration 069) says
  who is responsible per number.
- **Constraint deskcomm doesn't have:** wacrm sends on the Meta Cloud API
  too, where free-form messages are only allowed within 24h of the
  customer's last message. A human may answer a case hours later, when
  the AI can no longer send free-form text. deskcomm is WAHA-only, so its
  design never meets this.

## Proposed change

### 1. Schema (migration, next free number)

```sql
CREATE TABLE IF NOT EXISTS human_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  summary text NOT NULL CHECK (length(summary) <= 1000),
  blocker text NOT NULL CHECK (length(blocker) <= 500),
  -- text + CHECK, never an enum: a new state is a one-line migration.
  status text NOT NULL DEFAULT 'awaiting_human' CHECK (status IN
    ('awaiting_human','awaiting_lead','resolved','escalated','cancelled')),
  claimed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  -- Did the AI manage to tell the customer the latest outcome?
  relay_status text CHECK (relay_status IN
    ('pending','sent','window_closed','failed')),
  lead_unresponsive boolean NOT NULL DEFAULT false,
  opened_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
CREATE INDEX idx_human_cases_open
  ON human_cases (account_id, status)
  WHERE status IN ('awaiting_human','awaiting_lead');

CREATE TABLE IF NOT EXISTS human_case_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES human_cases(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind text NOT NULL,   -- opened | claimed | human_resolved | need_info
                        -- | lead_provided | lead_unresponsive | escalated
                        -- | cancelled | relay_sent | relay_failed
  actor_kind text NOT NULL CHECK (actor_kind IN ('ai','human','system')),
  actor_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  body text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- notifications.type CHECK widened: 'conversation_assigned' | 'case_opened'
--   | 'case_lead_replied' | 'case_relay_failed'
```

RLS: `SELECT` for `is_account_member`; **no** client write policy — every
transition goes through the API routes below under the service role, so
the state machine (§3) can't be bypassed by a browser `update`. (Contrast
with channel routing, where browser writes forced a trigger: cases have
no legitimate direct-from-browser write.)

### 2. Two AI tools (per-account opt-in)

`ai_configs.cases_enabled boolean NOT NULL DEFAULT false`. When on,
`auto-reply.ts` appends `CASE_TOOLS` and `createCaseToolExecutor` beside
the existing ones, and `buildSystemPrompt` adds a short "Cases" section.

- **`open_human_case`** — description *teaches the behavior*: "Open a case
  when you cannot solve the customer's request yourself (grant access,
  fix something in a system, a decision that needs a person). You keep
  talking to the customer — this does not silence you. Use it **every
  time** you are about to promise that someone will check or resolve
  something: promising without opening a case is forbidden." Args:
  `{ title, summary, blocker }` — strictly validated (unknown keys
  rejected, lengths capped, prototype-pollution guard as in
  `agenda.ts`). The conversation excerpt attached to the case is read by
  the **runtime from the real messages**, never from model arguments.
- **`provide_case_update`** — args `{ case_id, info }`; valid only when the
  case is `awaiting_lead` **and** belongs to this conversation (resolved
  from the turn's `conversationId`, never trusted from the payload);
  moves it back to `awaiting_human`, notifies the team.

Cap: at most 3 open cases per conversation and a per-account hourly limit,
so a looping model can't flood the queue. Errors return
`{"error": "…"}` teaching strings, as the other executors do.

### 3. State machine (pure module, single authority)

`src/lib/cases/state-machine.ts`, modeled on deskcomm's
`lib/campanhas/maquina-de-estados.ts` (a `PERMITIDO` table + `podeTransitar`;
the DB CHECK guards the *vocabulary*, the table guards the *order*):

```
awaiting_human ──human: done──────────► resolved   (AI relays outcome)
awaiting_human ──human: need info─────► awaiting_lead (AI asks customer)
awaiting_lead  ──AI: provide update───► awaiting_human
awaiting_human ──human: can't, take over► escalated (existing handoff)
any open       ──opt-out / conv closed─► cancelled
```

Every route calls `podeTransitar` before writing; every transition writes a
`human_case_events` row and an `audit()` entry.

### 4. The human's side — routes and UI

- `POST /api/cases/[id]/respond` (agent+): `{ action: 'done'|'need_info'|
  'escalate', note }`. `done` and `need_info` record the event, set
  `relay_status = 'pending'`, and schedule the **relay turn**; `escalate`
  runs the existing `handOffToHuman` with reason `case_escalated` (and the
  customer notice from the handoff spec).
- `POST /api/cases/[id]/claim` — "Assumir caso" sets `claimed_by`.
- **Relay turn** (`src/lib/cases/relay.ts`): runs in `after()` from the
  route, reuses `generateReplyWithFallback` with an injected, deterministic
  system block — the intent comes from the button, not from model
  interpretation:
  - `done`: "The team resolved case X with this note: '…'. Tell the
    customer naturally and close the topic."
  - `need_info`: "To resolve case X the team needs from the customer:
    '…'. Ask them; when you have it, call `provide_case_update`."
  Sends through `engineSendText` (`aiGenerated: true`).
- **24h window (Cloud API).** Before relaying, check the window. If closed,
  do not attempt a doomed free-form send: set `relay_status =
  'window_closed'`, raise a `case_relay_failed` notification, and show the
  human "Cliente não foi avisado — janela de 24h fechada. [Enviar modelo]
  [Assumir conversa]". Retry of `relay_status = 'pending'` rows (function
  frozen mid-`after()`) is done by the existing automations cron.
- **UI.** New "Casos" entry in the sidebar's *Atendimento* group
  (`navGroups` in `sidebar.tsx`): list with filters *Aguardando equipe /
  Aguardando cliente / Resolvidos*, row = title, contact, age, blocker;
  detail drawer = AI summary, the frozen conversation excerpt, event
  timeline, and the three actions above. A chip in the thread header
  ("Caso aberto: Liberar acesso") links back. Realtime on `human_cases`
  keeps it live.
- **Who is paged.** On `case_opened` / `case_lead_replied`: the
  conversation channel's `channel_routing_responsibles` when configured
  (spec 069), else every `agent`+ member — via `notifications` and
  `sendPushToAccount`.

### 5. The requirement that matters most: the AI must not "forget"

deskcomm's own spec calls this the real risk: the model *says* "vou chamar
alguém" and never opens a case. Three layers:

1. The tool description + prompt section above (prevention).
2. **A deterministic promise detector** on the model's outgoing text, per
   locale (pt/en/es/ko regex lists, unit-tested, in
   `src/lib/cases/promise-guard.ts`): if the reply promises human follow-up
   ("vou verificar com a equipe", "vou chamar um atendente",
   "someone will check…") and **no case is open** and the model did not
   call `open_human_case` this turn, then **auto-open a fallback case**
   (title from the customer's last message, `actor_kind = 'system'`).
   It only auto-opens when no open case exists, so it can't spam
   duplicates. This is the fail-safe; it must never block or rewrite the
   customer's message.
3. The `cases_enabled = false` default: a promise with cases off is just
   the old behavior (and `handoff-customer-notice` covers the handoff).

## Acceptance criteria

- [ ] With cases enabled, the AI can open a case mid-conversation and
      **keeps replying** to the customer (conversation not paused,
      `ai_autoreply_disabled` untouched).
- [ ] A teammate answering "Concluído" makes the AI relay the outcome to
      the customer in a natural message; "Preciso de info" makes it ask
      the customer, and the customer's answer (via `provide_case_update`)
      returns the case to the team with a notification.
- [ ] "Não consigo — assumir" hands off through the existing path and the
      customer is notified (handoff spec).
- [ ] The state machine rejects illegal transitions (unit-tested table,
      including double-click idempotence returning a no-op).
- [ ] `provide_case_update` on a case belonging to another conversation or
      account is rejected.
- [ ] A reply containing a human-follow-up promise with no open case
      auto-opens exactly one fallback case; a second such reply does not
      open another.
- [ ] Relaying after the Cloud API 24h window closed sets
      `relay_status = 'window_closed'`, notifies, and does not send.
- [ ] A browser `update` on `human_cases` is rejected by RLS.
- [ ] Opt-out or a closed conversation cancels open cases.
- [ ] `notifications` CHECK widened; `verify-schema.sql` asserts both new
      tables, the CHECKs and the partial index; all four locales updated.

## Risks / open questions

- **Fail-safe false positives.** A regex will sometimes auto-open a case
  the customer didn't need. Cheap to close, expensive to miss — but ship
  it behind `cases_enabled` and log every auto-open for tuning.
- **The relay reads the human's note verbatim into a prompt.** Treat it as
  untrusted text (length cap, no tool calls allowed in the relay turn,
  instruction to never disclose internal notes) — a teammate typo or a
  pasted secret must not go to the customer unfiltered.
- **`after()` durability** in a route handler, not a webhook — same
  frozen-function class of bug as issue #301. The `relay_status =
  'pending'` + cron retry is the mitigation; confirm on the real host.
- **Scope of "who can respond"**: `agent`+ can answer any case. Restricting
  by channel responsibles is possible later; not needed for v1.
- **Overlap with `human_cases` in `docs/`**: deskcomm has a WhatsApp-side
  "aviso de caso" (page the team on WhatsApp). Not ported — wacrm has
  push and in-app notifications instead.

## Delivery phases

1. Schema + state machine + tools + relay + API (no UI; testable).
2. "Casos" page, thread chip, notifications/push.
3. Promise detector + tuning log.
