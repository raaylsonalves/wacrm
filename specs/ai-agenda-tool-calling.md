# Spec: AI assistant can check and book appointments (tool calling)

## Problem

The AI auto-reply agent (`src/lib/ai/`) is pure text-in/text-out — none
of the three provider adapters (`src/lib/ai/providers/{openai,
anthropic,gemini}.ts`) send or parse anything but plain chat turns.
It cannot check the agenda (`src/lib/appointments/`) or create an
`appointments` row; the only non-text side effect it has today is the
`[[HANDOFF]]` sentinel.

The Agenda feature (`specs/agenda-appointments.md`) already ships a
Flow node (`offer_slots`) that lets a deterministic button-menu flow
offer free slots and book the tapped one. The business also wants the
*free-form* AI conversation to do the same thing — a customer typing
naturally ("quero marcar quinta de manhã", "dia 15 as 14h tem
horário?") should get a real, live answer grounded in the actual
calendar, not a guess, and be able to book without leaving the chat.

Confirmed by direct code read (this conversation): zero tool-calling
infrastructure exists in any of the three provider adapters, and
`src/app/api/whatsapp/webhook/route.ts:1044` explicitly skips AI
auto-reply for interactive (button/list) replies — so even reusing the
Flow engine's list-sending code as a one-off send wouldn't let the AI
see the customer's tap today.

## Non-goals

- Voice / audio input — separate spec, `ai-audio-message-support.md`.
- Cancelling an existing appointment via the AI outright (no
  replacement time) — not requested yet; `reschedule_appointment`
  covers the "move it" case, which is what actually came up live.
- Booking to a specific agent's calendar — the AI books to the shared
  calendar only (`assigned_to = null`); per-agent assignment via AI is
  a later iteration if needed.
- A general-purpose tool-calling framework for arbitrary future tools
  — this spec ships three tools (`offer_slots`, `book_appointment`,
  `reschedule_appointment`) and the minimum plumbing to run them. A
  fourth tool later reuses the same plumbing.
- Draft replies (`/api/ai/draft`) and the playground (`/api/ai/
  playground`) gaining tool calling — a draft is reviewed by a human
  before sending, so a tool call that sends a WhatsApp message or
  writes an appointment as a *preview* would be a real side effect the
  human never approved. Tools are wired into the auto-reply path
  (`generateReplyWithFallback`) only.

## Current behavior

- `src/lib/ai/types.ts` — `AiConfig` has no agenda flag;
  `GenerateArgs`/`ProviderArgs` carry `{ apiKey, model, systemPrompt,
  messages, timeoutMs }` only, no `tools`.
- `src/lib/ai/providers/{openai,anthropic,gemini}.ts` — each POSTs a
  single request and returns `{ text, usage }`. No tool/function
  schema in the request body, no parsing of a tool-call response.
- `src/lib/ai/context.ts` `buildConversationContext` selects
  `.eq('content_type', 'text')` only — a customer's tap on an
  interactive list (`content_type = 'interactive'`) is invisible to
  the model even though `messages.content_text` already holds a
  human-readable label for it (the webhook's `parseMessageContent`,
  `route.ts:1233-1250`, sets `contentText: reply.title` and
  `interactiveReplyId: reply.id` for every button/list tap).
- `src/app/api/whatsapp/webhook/route.ts:1044` —
  `if (!flowConsumed && !interactiveReplyId && inboundText.trim())` —
  auto-reply is dispatched for plain text only; an interactive tap
  never reaches `dispatchInboundToAiReply`, regardless of who sent the
  prompt it's replying to.
- `src/lib/flows/meta-send.ts` `engineSendInteractiveList` /
  `sendInteractiveViaMeta` inserts the outgoing message without an
  `ai_generated` flag (that column is only threaded through
  `engineSendText`'s `aiGenerated` param today) — there is no way to
  tell, from the `messages` row alone, whether a past interactive
  prompt came from the AI or from a Flow.
- `src/lib/flows/engine.ts` `offerSlotsAndSuspend` / `bookOfferedSlot`
  (lines ~498-627) already contain the exact logic this spec needs —
  compute free slots, send them as a WhatsApp interactive list, parse
  a tapped `slot:<ISO>` reply id, insert the `appointments` row,
  handle the `23P01` exclusion-constraint race — but it's private to
  the flow runner and threaded through a `FlowRunRow`, not reusable as
  is from the AI path (no `flow_run` exists there).
- `appointments.source` (migration 058) is `CHECK (source IN
  ('manual', 'flow'))` — no `'ai'` value yet.
- `ai_configs` has no per-account opt-in for this — every capability
  the assistant has today is either always-on (handoff) or config-
  driven by an existing column; there's no "give the AI Agenda access"
  toggle in `src/components/settings/ai-config.tsx`.

## Proposed change

### 1. Two tools, not a generic framework

`src/lib/ai/tools/agenda.ts` exports:

- `AGENDA_TOOLS: ToolDefinition[]` — JSON-schema tool definitions for
  `offer_slots` and `book_appointment` (see below), provider-neutral.
- `createAgendaToolExecutor(ctx): ToolExecutor` — closes over
  `{ db, accountId, conversationId, contactId, userId }` and returns
  `(name, args) => Promise<string>` (the string is fed back to the
  model as the tool result — JSON, including on error, so the model
  can react instead of the whole reply throwing).

**`offer_slots`** — read + a WhatsApp side effect, mirrors
`offerSlotsAndSuspend`:
- args: `{ date?: "YYYY-MM-DD", period?: "morning"|"afternoon"|"any",
  days_ahead?: number, duration_minutes?: number, max_options?: number
  (≤10), intro_text: string, button_label: string }`.
- Loads `appointment_settings` + shared-calendar busy ranges
  (`assigned_to: null`, same partition the v1 UI's shared calendar
  uses), calls `generateFreeSlots` from `src/lib/appointments/slots.ts`
  unchanged. When `date` is given, restricts to that single day (a new
  day-offset + post-filter helper local to this file — `slots.ts`
  itself is untouched, no risk to its existing tests). When `period` is
  given, filters by local hour (`< 12` morning, `>= 12` afternoon).
- `slots.length === 0` → returns `{ sent: false, slots: [] }`, no
  WhatsApp message — the model tells the customer nothing was free and
  should suggest another day/period.
- `slots.length > 0` → sends the interactive list via
  `engineSendInteractiveList` (now accepting `aiGenerated: true`, see
  §3) with the model-authored `intro_text`/`button_label`, and returns
  `{ sent: true, count, slots: [{ id, label }] }`. Always sends the
  list, even for a single slot — same as the Flow node, no special
  case, so behavior is one code path.
- Booking itself does **not** happen here — a customer's tap is a
  separate inbound turn (§2), and a model that already has an exact
  date+time can skip straight to `book_appointment` without calling
  this tool at all (see prompt guidance in §4).

**`book_appointment`** — write, mirrors `bookOfferedSlot`:
- args: `{ slot_id?: string, date?: "YYYY-MM-DD", time?: "HH:MM",
  duration_minutes?: number, title?: string }` — either `slot_id` (a
  value the model saw verbatim in `offer_slots`'s result or in the
  transcript annotation from §2) or `date`+`time` (the "customer named
  an exact slot in conversation, already confirmed free" path).
- Resolves the start instant, inserts into `appointments` with
  `assigned_to: null`, `source: 'ai'`, `conversation_id`, `contact_id`.
  Catches `23P01` (either exclusion constraint) → `{ error: "conflict"
  }`, so the model apologizes and offers to call `offer_slots` again
  rather than the whole turn failing.
- On success: `{ booked: true, date, time, title }`. The model itself
  writes the natural-language confirmation from this — no canned
  string is built here (unlike the Flow node's `vars.agendamento`,
  there's no fixed next message to fill).

**`reschedule_appointment`** — write, added after a live gap: the
model's only write tool was `book_appointment`, so a customer asking to
move their time got a *second* appointment instead of the first one
moving — confirmed live (same contact, two `scheduled` rows, the
original never cancelled).
- args: `{ slot_id?: string, date?: "YYYY-MM-DD", time?: "HH:MM",
  duration_minutes?: number }` — same shape as `book_appointment`
  minus `title` (kept from the original row).
- Looks up the contact's soonest upcoming, non-cancelled appointment
  (`account_id` + `contact_id`, `starts_at > now()`, earliest first) —
  no `flow_run_id`/conversation scoping, since a customer might have
  booked through a different thread than the one asking to move it.
  No match → `{ error: "no_appointment_found" }` (the model should
  offer `book_appointment` instead). `duration_minutes` defaults to
  the existing appointment's own length when omitted.
- Resolves the new start the same way as `book_appointment`, then a
  single `UPDATE appointments SET starts_at, ends_at WHERE id = ...`
  on that row — not a cancel-then-insert — so a `23P01` conflict on the
  new time leaves the original booking exactly as it was rather than
  losing it mid-move.
- On success: `{ rescheduled: true, date, time }`.
- **Known simplification**: if a contact somehow has more than one
  upcoming appointment (shouldn't happen once this ships, but existing
  test data can), only the soonest one is ever the reschedule target —
  no way to pick a specific one by tool call today.

### 2. Interactive taps become visible + routable to the AI

- `buildConversationContext` (`src/lib/ai/context.ts`): widen the
  `content_type` filter to `.in('content_type', ['text',
  'interactive'])`, select `interactive_reply_id` too, and when it's
  set, append it to the mapped content as `` `${label} (id:
  ${interactive_reply_id})` `` so a later model turn can quote the exact
  id back into `book_appointment`. This is a strict superset of today's
  behavior for every other caller of this function (drafts, playground)
  — an interactive tap simply becomes one more legible transcript line,
  which is a general correctness improvement on its own, not just an
  agenda-specific hack.
- `src/lib/flows/meta-send.ts`: add `aiGenerated?: boolean` to
  `SendInteractiveButtonsEngineArgs` / `SendInteractiveListEngineArgs`,
  threaded into `sendInteractiveViaMeta`'s insert (`ai_generated:
  input.aiGenerated ?? false`) — same pattern `engineSendText` already
  has, just extended to the interactive senders.
- `src/app/api/whatsapp/webhook/route.ts`: replace the blanket
  `!interactiveReplyId` exclusion with a check of who sent the prompt
  being replied to — the most recent `sender_type = 'bot'` message in
  the conversation. When that row has `ai_generated = true`, dispatch
  `dispatchInboundToAiReply` for the tap exactly like a text message
  (same eligibility gates apply — assigned agent, autoreply disabled,
  cap, etc. are unaffected). When it's `false` or there's no prior bot
  message, behavior is unchanged (no AI dispatch on the tap) — a tap on
  a Flow's or automation's own interactive message still only fires
  automations' `interactive_reply` trigger, as today.

### 3. Config: opt-in per account

- Migration `060_ai_configs_agenda_tool.sql`: `ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS agenda_enabled boolean NOT NULL DEFAULT
  false`. Off by default — an account with no `appointment_settings`
  configured shouldn't suddenly have its bot offering to book things.
- `src/lib/ai/config.ts` `loadAiConfig`: select + map the new column
  onto `AiConfig.agendaEnabled` (same defensive `isUndefinedColumnError`
  fallback pattern already used for `fallbacks`, in case this migration
  hasn't landed yet on a given deploy).
- `src/components/settings/ai-config.tsx`: a toggle ("Agenda —
  o assistente pode consultar e marcar horários") next to the existing
  auto-reply switches, only meaningfully useful once
  `appointment_settings` exists — copy says so.
- Migration `061_appointments_ai_source.sql`: widen
  `appointments_source_check` to `CHECK (source IN ('manual', 'flow',
  'ai'))`.

### 4. Wiring + prompt

- `src/lib/ai/types.ts`: add `agendaEnabled: boolean` to `AiConfig`;
  add `ToolDefinition` / `ToolCall` / `ToolExecutor` types.
- `src/lib/ai/providers/shared.ts` `ProviderArgs` gains optional
  `tools?: ToolDefinition[]` and `executeTool?: ToolExecutor`. Each
  provider adapter maps `AGENDA_TOOLS` to its own wire shape (OpenAI
  `tools: [{type:'function', function:{...}}]` +
  `message.tool_calls`/`role:'tool'`; Anthropic `tools: [{name,
  description, input_schema}]` + `content: [{type:'tool_use'|
  'tool_result'}]`; Gemini `tools: [{functionDeclarations}]` +
  `functionCall`/`functionResponse` parts) and runs its own bounded
  loop (cap: 3 tool round-trips) calling `executeTool` and re-posting
  until the model returns plain text or the cap is hit (at the cap,
  treat it like today's "empty response" case — surfaces as an
  `AiError`, which `generateReplyWithFallback` already retries/hands
  off on). Every existing adapter test keeps passing unmodified: `tools`
  absent ⇒ identical request body and single-shot behavior as today.
- `src/lib/ai/generate.ts` `generateReply` forwards `tools`/
  `executeTool` straight through to the chosen adapter.
- `src/lib/ai/generate-with-fallback.ts` `generateReplyWithFallback`
  forwards the same two fields to each tier's `generate()` call.
- `src/lib/ai/defaults.ts` `buildSystemPrompt` gains an
  `agendaToolsEnabled?: boolean` option; when true, appends a block
  explaining: prefer `offer_slots` when the customer is vague about
  time or gave a range/period; call `book_appointment` directly (no
  `offer_slots`) when they named an exact day+time you haven't already
  shown as a list; when a transcript line ends in `(id: slot:...)`
  that's the customer tapping one of your own offered options — pass
  that id straight to `book_appointment`; never invent availability —
  only speak from a tool's result.
- `src/lib/ai/auto-reply.ts` `dispatchInboundToAiReply`: when
  `config.agendaEnabled`, build `tools: AGENDA_TOOLS` and `executeTool:
  createAgendaToolExecutor({ db, accountId, conversationId, contactId,
  userId: configOwnerUserId })`, pass both into
  `generateReplyWithFallback`, and pass `agendaToolsEnabled: true` into
  `buildSystemPrompt`.

## Acceptance criteria

- [ ] An account with `agenda_enabled = false` (the default) behaves
      exactly as today — no tools in the request body, existing tests
      unaffected.
- [ ] An account with `agenda_enabled = true` and a business-hours
      configuration: a customer typing "quero marcar quinta de manhã"
      gets a real WhatsApp interactive list of free slots, computed
      from live `appointments` + `appointment_settings`.
- [ ] A customer typing an exact free day+time gets a direct booking
      (no list) with a natural-language confirmation from the model.
- [ ] Tapping a row from an AI-sent list results in a booked
      `appointments` row (`source = 'ai'`) and a confirmation message,
      without a human ever seeing an "interactive reply" go unanswered.
- [ ] A tap on a Flow-sent or automation-sent interactive message is
      unaffected — no AI dispatch, exactly like today.
- [ ] A customer with an existing upcoming appointment asking to move
      it ends up with exactly one appointment (the moved one) — never
      two.
- [ ] A booking race (two customers tapping the same slot) surfaces as
      `{error:"conflict"}` to the model, which apologizes and re-offers
      rather than crashing the auto-reply.
- [ ] Draft (`/api/ai/draft`) and playground calls never receive
      `tools`/`executeTool` — verified by reading the route, no new
      test needed since those routes don't change.

## Risks / open questions

- **Tool-call loop cost**: each round trip is a full provider request;
  worst case (offer → customer replies with something ambiguous →
  model tries again) is a few extra billed calls per booking. Same
  order of magnitude as retrieval + generation today: acceptable, but
  worth surfacing in `ai_usage_log` the same way transcription calls
  are flagged in `ai-audio-message-support.md`'s open question — not
  built in this pass, revisit if cost becomes a complaint.
- **Model reliability on structured args**: a model can mis-format
  `date`/`time` or invent a `slot_id`. `book_appointment` validates
  both defensively (regex parse, reject unparsable/past times) and
  returns a plain-English `{error}` string rather than throwing, so a
  malformed call degrades to "let me check again" instead of a crash.
- **Multi-tenant WhatsApp session window**: an `offer_slots` send is a
  free-form message, same 24h-window constraint as any other
  auto-reply — no new risk beyond what already exists for auto-reply
  responses.
- **Per-agent booking via AI**: deliberately deferred (Non-goals) —
  if requested later, `book_appointment` gains an `assigned_to` arg and
  needs the same `resolveAssignee` tenancy check the Flow node uses.
