# Spec: Guardrails on what the AI sends (a `before_send` gate chain)

> Ported in spirit from deskcomm's `lib/agent-engine/guardrails/`
> (`before-send.ts`, 1,450 lines). That chain is the difference between
> "the prompt asks the model to behave" and "the system **checks** what
> the model wrote before the customer sees it". wacrm has only the first.
> Pillar 3 of `specs/product-differentiators.md`.

## Problem

Every safety rule the AI has today is a **sentence in the system prompt**
(`src/lib/ai/defaults.ts:117-124`): never invent prices or promises,
treat customer text as untrusted, reply with the handoff sentinel when
unsure. A prompt is a request, not a control. Nothing between
`generateReplyWithFallback()` and `engineSendText()` in
`src/lib/ai/auto-reply.ts` looks at the text that is about to go out, so:

- a model that offers "50% off, 12x no juros" sends it — the account finds
  out from the customer, at the counter;
- a model that says "vou encaminhar para o time" **without** handing off
  (the case `defaults.ts` warns about) leaves the customer promised a
  human who was never notified;
- a reply can leak internal vocabulary (tool names, table names, role
  names, a raw provider error) to a customer;
- a contact who opted out can still be answered by the AI on a later
  message;
- a jailbreak in a customer message ("ignore your instructions and…") is
  handled only by the model's own compliance.

For accounts that put the AI in front of real customers with no human in
the loop — the small-business case operated on their behalf, and the
company case with compliance — "we asked it nicely" is not an answer.

## What deskcomm has (read from the code)

A **fixed, ordered, versioned chain** of gates between the model's
`send_message` tool and the channel. Each gate can **veto**; the reason
goes back *to the model* as an instructive error so it can rewrite; only
if every gate passes does the message reach the channel.

| # | Gate | What it checks | Kind |
|---|---|---|---|
| 1 | stop / opt-out | contact blocked or forced to human — **irrevocable**, always first | deterministic |
| 2 | lgpd | anonymised contact; first cold touch without a legal basis | deterministic |
| 3 | anti-ban | window, throttle, warm-up, daily caps | deterministic |
| 3.5 | messaging window | 24h session; a template passes it | deterministic |
| 4 | spinning | anti-repetition of near-identical copies | deterministic |
| 5 | promise (table) | price below the org's floor, discount above its ceiling, more installments than allowed | deterministic, per-org versioned table |
| 6 | promise (semantic) | an LLM judges promises the regex can't | **LLM, costs per message, per-org switch** |
| 6.5 | case promise | promised to involve a human but no case is open → vetoed until one exists | deterministic |
| 6.7 | internal vocabulary | tool/table/role names, architecture terms, raw errors reaching a customer | deterministic |
| 7 | disclosure | first message must say it's a virtual assistant (inject or veto mode) | deterministic, per-org template |

Design rules worth copying:

- **The order is a code constant, not runtime config**, with a test that
  locks order, length and version. "Stop first" is a safety invariant;
  changing the chain must turn CI red *first* so the change is seen, not
  presumed. (deskcomm found its own comment described a guard that didn't
  exist and added the test.)
- **Deterministic gates cost nothing and are nobody's choice.** Only the
  two LLM layers (semantic promise, jailbreak classifier) cost money, so
  only they are per-organisation switches — and the switch has **three
  states**: `null` = "this org didn't choose, the environment default
  applies", never collapsed into `false`, or a deploy silently turns off
  what an installation had on.
- **Catch form, never business meaning.** The vocabulary-leak gate hunts
  identifiers (`crm_list_webhook_sources`, `Role 'agent' insufficient`),
  not words like "etapa"/"funil" — those are the customer's own stage
  names and banning them would ban the one correct answer.
- **Every evaluated gate leaves a trace** (gate, verdict, code) in a
  table exportable per run — the answer to "why was this blocked".
- **Serialisation per number** (advisory lock) so two workers can't both
  read "cap − 1" and overshoot.
- **The jailbreak read is advisory**: it flags the turn and, alongside an
  out-of-table promise, opens an item for a human; it never rewrites.

## Non-goals

- A general content-moderation product. These are commercial-risk and
  trust guards for an assistant speaking for a business.
- Replacing the prompt rules — they stay; the gates are the backstop.
- The LLM-judged layers in v1 (they cost per message and need the
  three-state switch); listed as phase 2.
- deskcomm's anti-ban/spinning gates: wacrm's WAHA throttle
  (`claim_waha_send_slot`) already covers pacing; spinning is a separate
  question (see `specs/prospecting-csv-import.md`).

## Current behavior (wacrm)

- `defaults.ts` prompt: no invented facts/prices/promises; customer text
  is untrusted; hand off with `HANDOFF_SENTINEL`; never state a slot is
  free without a tool result. All advisory.
- `auto-reply.ts`: eligibility gates run **before** generation (AI on,
  no human assigned, not paused, reply cap, per-account rate limit).
  Nothing runs **after** generation except the handoff sentinel test
  (`handoff || !text`).
- `contacts.opted_out_at` exists and the webhooks set it; the AI path does
  not consult it (the handoff notice does, since 072).
- Reply segmentation (`generation.segments`) means the gate must judge
  the **joined** text once, then send segments — never per bubble.

## Proposed change

### 1. One seam: `src/lib/ai/guardrails/`

```ts
export const BEFORE_SEND_CHAIN_VERSION = 1
export const BEFORE_SEND_GATES = [
  'opt_out', 'price_promise', 'human_promise', 'internal_vocabulary',
  'disclosure',
] as const            // order is the contract; tested

export type GateVerdict =
  | { pass: true; rewrite?: string }          // disclosure "inject" mode
  | { pass: false; code: string; reason: string }   // reason is for the model

export function runBeforeSend(ctx: GateContext, text: string):
  { ok: true; text: string; traces: Trace[] } |
  { ok: false; veto: { gate: string; code: string; reason: string }; traces: Trace[] }
```

Pure and synchronous like deskcomm's gates; the caller loads
`GateContext` once (contact flags, account promise table, disclosure
template, whether this is the first outbound, whether a handoff/case is
open). Called in `auto-reply.ts` on the joined text right before the
segment loop, and by the prospecting approach sender.

### 2. The v1 gates (all deterministic, no extra AI cost)

1. **`opt_out`** — contact `opted_out_at` set → veto, irrevocable, first.
   Exempt only the handoff notice's own opt-out confirmation
   (`handoff-customer-notice.md`), which is not an AI reply.
2. **`price_promise`** — optional per-account table
   `{ min_price_cents, max_discount_percent, max_installments }`. Extract
   money / percent / "Nx" patterns from the reply (pt/es/en); over the
   limit → veto with the allowed value in the reason. An account with no
   table → gate is a no-op (opt-in by publishing one). Versioned, immutable
   rows with an active pointer so a change is auditable and rollback is a
   pointer move (deskcomm's `promise_table_versions`).
3. **`human_promise`** — reply promises to involve the team ("vou
   encaminhar", "nossa equipe vai retornar") while no handoff/case exists
   → veto with reason "use the hand-off, don't say it"; on the second
   attempt in the same turn, **hand off** with reason `guardrail_veto`
   (new reason code in the 072 CHECK). Conservative regex calibrated for
   low false positives: "verificar no sistema" is not a human, "nossa
   equipe está sempre à disposição" is institutional, not a promise.
4. **`internal_vocabulary`** — identifiers and architecture words that
   only exist inside the system (tool names, table names, role names, raw
   provider errors, stack-trace shapes). Catches **form**, never business
   words.
5. **`disclosure`** — per-account text; `inject` (prepend on the first
   outbound) or `veto` mode. No template → no-op. Matters most for
   accounts that must state "assistente virtual" (compliance).

### 3. What a veto does

The reason goes back to the model as a corrective turn and it regenerates
**once**. Second veto in the same turn → hand off (reason
`guardrail_veto`, `meta.gate`/`meta.code`) and the customer notice from
`handoff-customer-notice.md` goes out. Never send a vetoed text; never
loop. Each regeneration is a real provider call, so it is logged in
`ai_usage_log` like any other.

### 4. Traces and the inbox

`ai_guardrail_traces (id, account_id, conversation_id, gate, verdict,
code, created_at)` — one row per **gate that vetoed** in v1 (passes are
counted, not stored, to keep the table small; store all under a debug
flag). The handoff banner already renders a reason; a `guardrail_veto`
reason shows "Resposta bloqueada: <gate legível>" with the blocked text
behind "ver mais" for the human. A small settings card (Settings → AI
Assistant → Segurança) lists which gates are active and the last vetoes.

### 5. Phase 2 (paid layers, per-account, three-state)

Semantic promise judge and jailbreak classifier on a cheap model, each a
separate switch stored as `org_guardrail_layers (layer, enabled)` with
**absent row = not chosen** (falls back to a default), never a boolean
defaulting to false. Jailbreak stays **advisory** (flags the turn), as in
deskcomm.

## Acceptance criteria

- [ ] A reply containing a discount above the account's ceiling is never
      sent; the model is asked once to rewrite; a second violation hands
      off with reason `guardrail_veto`.
- [ ] An account with no promise table is unaffected (gate is a no-op).
- [ ] A reply promising "vou passar para o time" with no handoff is
      vetoed; the same sentence with a handoff already made passes.
- [ ] "Vou verificar seu pedido no sistema" and "nossa equipe está sempre
      à disposição" are **not** vetoed (fixtures for both traps).
- [ ] A reply containing `crm_*`/table/role identifiers is vetoed; a reply
      using the customer's own stage names ("etapa", "funil") is not.
- [ ] An opted-out contact receives no AI reply on any path; the
      opt-out confirmation of the handoff notice is the only exception.
- [ ] Disclosure `inject` prepends exactly once (first outbound only).
- [ ] The chain's order/length/version is locked by a test that fails
      first when the chain is changed on purpose.
- [ ] Segments are gated once on the joined text.
- [ ] `verify-schema.sql` asserts the new tables/columns; four locales;
      the new reason code is in the 072 CHECK (new migration widens it).

## Risks / open questions

- **False positives cost more than they save if the regexes are
  greedy.** A blocked good reply → a needless handoff. Calibrate down,
  fixture the traps, ship in **observe mode first** (traces only, no veto)
  for a week per account, then enforce — deskcomm does the same with its
  newer AI layers ("observando → decidindo").
- **Regenerate-once doubles cost on a vetoed turn.** Acceptable; vetoes
  should be rare, and the trace count tells us if they aren't.
- **Money extraction across locales** ("R$ 1.299,90", "1,299.90", "mil e
  duzentos") is the hard part of `price_promise`; start with numeric
  forms and reject-by-default is wrong here — unknown form = pass, not
  veto.
- **Where the chain runs for tool-driven sends.** wacrm's AI replies come
  back as text and the server sends them; deskcomm's chain guards a
  `send_message` tool. Same seam (before the send), different shape —
  confirm no other code path sends AI text (agenda tools send their own
  messages: `offer_slots`).
