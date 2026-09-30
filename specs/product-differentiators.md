# Spec: Where wacrm can differ from other WhatsApp CRMs

**Status (2026-09-30): strategy note, not a build spec. Its pillars are tracked in the specs that implement them (guardrails, follow-ups, cases, operator mode).**

> Strategy note with buildable pillars, written after comparing with
> deskcomm and discussing the market with the product owner
> (2026-09-29). It is **not a competitor study** — no market research was
> done for it; it starts from what wacrm and deskcomm already have. Run a
> real competitor pass before using it in sales copy.

## Who it is for (decision)

Two audiences on one codebase, and that shapes every pillar:

1. **Small businesses that don't want to manage a CRM** (a barbershop, a
   clinic): the owner wants WhatsApp answered and appointments on their
   Google Calendar; the **operator** (the product owner) runs the number
   and the automation for them.
2. **Companies that run the CRM themselves**: teams with agents, funnels,
   compliance, several numbers.

A feature must work for both or be visibly gated by role/mode. The
operator mode is not a separate product: it is the same account model
seen through a portfolio (`specs/operator-multi-account.md`).

## What the category looks like (from what we know, unverified)

Inbox, funnel, flow-builder chatbot, broadcast, a bolted-on AI. Those are
table stakes and not where to compete. The gaps that recur in what we
studied are about **trust**: leads silently lost, numbers banned, an AI
nobody can audit.

## The pillars

### 1. "No lead is lost" — and we can prove it

A promise, made measurable. Every conversation has an **owner** and a
**next action with a deadline**; anything that goes quiet is caught.

| Piece | Spec | State |
|---|---|---|
| Customer is told when the AI hands off | `handoff-customer-notice.md` | **built** (072) |
| Follow-up so a conversation doesn't die | `followup-sequences.md` | specced |
| The AI delegates a task instead of giving up | `human-cases.md` | specced |
| Cold leads followed through a funnel | `prospecting-csv-import.md` | specced |

New here: a **"conversas em risco" view** — conversations with a customer
message unanswered past a threshold, AI handoffs nobody picked up, cases
with a missed promise — and one headline number on the dashboard
("conversas abandonadas nos últimos 7 dias"). deskcomm has the same idea
(`lib/leads/risk-radar.ts`, `next-action.ts`); port the model, not the
code. Success metric: median time to first human response after a
handoff, and abandoned-conversation count trending to zero.

### 2. The number is the customer's asset — protect it

The biggest real-world pain on WAHA numbers is the ban. Make protection a
product surface, not a warning paragraph:

- **Number health** per channel: age/warm-up stage, sends in the last 24h
  vs the allowed ceiling, opt-out and failure rate, last disconnect.
  Red/amber/green with a plain reason.
- Rules as **product limits, not settings**: stepped warm-up ceilings,
  interval with delay-only jitter, sending window, daily cap across all
  cold sends, one running prospecting campaign, opt-out line on every
  cold message, refusal to send cold text on the Cloud API.
- **Rotation** (already built for broadcasts) surfaced as "if this number
  degrades, traffic shifts".
- **Alert before it breaks**: a push/notification when a number crosses
  amber (failure rate up, disconnected, QR expired).

Builds on: WAHA throttle + rotation (064/068), `prospecting-csv-import.md`
§4.3, `operator-multi-account.md` (portfolio health).

### 3. An AI you can govern

The assistant is the riskiest thing a small business hands to software.
Make it inspectable and bounded:

- **Output guardrails** — checked in code before anything is sent:
  `ai-output-guardrails.md`.
- **Manageable agents**: per-agent model from the provider's own list,
  versions, per-agent usage/cost, a page to edit them:
  `ai-agents-management.md`.
- **Why did it do that**: handoff reason (built), blocked-reply trace,
  which knowledge chunks grounded an answer.
- **Bring-your-own-key cost transparency** (already true): the customer
  sees exactly what the AI costs, per agent and per conversation.

### 4. Vertical packs + operator mode (the small-business side)

A pack = a ready configuration for a niche — barbershop, clinic, salon:
agent prompt and knowledge starter, appointment rules, funnel stages,
follow-up sequence, reminder templates, and the Google Calendar link.
Onboarding becomes "pick your business type, connect the number (QR),
connect Google" instead of building a CRM.

Depends on `google-calendar-sync.md` and `operator-multi-account.md`
(portfolio, simplified owner view, client-facing links so the client
scans the QR / grants Google without sharing a password). **Open product
decision** recorded in the operator spec: multi-account in one database
vs one installation per client.

### 5. A CRM the AI itself can operate

wacrm already ships an MCP server (`mcp-server/`) over `/api/v1`. Extend
it into a real differentiator: the owner asks their own assistant "who
hasn't replied this week?" or "send the reminder to tomorrow's clients"
and it acts **inside the same guardrails** (write scopes opt-in, broadcast
scope opt-in, opt-out and consent gates enforced server-side, never in
the client). Priority is low until pillars 1–3 exist — an AI-operated CRM
without those guarantees is a liability.

## Sequencing

1. Finish the trust core: follow-up sequences → human cases → output
   guardrails (observe mode first).
2. Number health + the risk view (small, high-visibility, mostly reads
   of data we already write).
3. Prospecting campaign (needs the follow-up sequences and the deal-move
   tool).
4. Operator mode + Google Calendar + the first vertical pack (decide the
   tenancy question first).
5. MCP-operated CRM.

Pillars 1–3 serve both audiences immediately; 4 is the small-business
wedge and the largest bet.

## Non-goals

- Competing on channel count (Instagram, Telegram, …) or on a
  drag-and-drop flow builder — they exist and are not where trust is won.
- Claiming compliance or ban-proofing. The product **reduces** risk and
  records choices; responsibility for lawful basis and for the number
  stays with the account, and the copy must say so.
- Marketing claims from this document: it has no measured data behind it.

## Open questions

- Which niche first for the vertical pack (barbershop was the example)?
- Pricing/packaging implications of operator mode (per client number?
  billing per extra number is already an open gap).
- Do we want the "no lead is lost" number visible to the *customer's
  customer*-facing owner (small business) or only to the operator?
- How much of pillar 2's health scoring can be computed from data we
  already store (sends, failures, opt-outs) vs needing new counters?
