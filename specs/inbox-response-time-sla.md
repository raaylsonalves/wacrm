# Spec: Per-conversation response-time SLA indicators in the inbox

## Problem

`accounts.response_time_target_minutes` (migration 049, Settings >
Response time) drives a single aggregate "target Xm" pill on the
*dashboard's* response-time chart — it tells you whether the team is
meeting its SLA on average, historically. It says nothing on the
*inbox* itself, in the moment: an agent looking at the conversation
list today has no way to see "this customer has been waiting 40
minutes and our target is 5" without doing the math themselves.

## Related, but distinct, existing feature

The inbox thread header already shows a "Xh restantes" / "Xm restantes"
badge (`message-thread.tsx`, `sessionInfo` ~lines 236-261, rendered
~line 942-951). That is **not** an SLA — it's the countdown on Meta's
24-hour WhatsApp customer-service window: once a customer messages you,
you can send free-form replies for 24 hours from their last message;
past that, only approved template messages go through
(`src/lib/whatsapp/meta-api.ts` lines ~355, ~490 reference this same
rule). It's a fixed platform constraint, not a configurable target, and
it measures "time left to reply at all," not "time since we should
have replied." Don't conflate the two when implementing this spec —
they can (and should) both show in the UI, but they answer different
questions.

## Non-goals

- Changing how the SLA target is configured — `Settings > Response
  time` (added alongside this spec) already covers that; this spec
  only covers *displaying* it against live conversations.
- SLA escalation workflows (auto-reassign, notify a manager on breach)
  — that's an automations/flows feature, not an inbox display feature.
  A future spec could wire a "SLA breached" event into the existing
  Automations trigger types (`src/lib/automations/trigger-meta.ts`) if
  wanted, but it's out of scope here.
- Per-pipeline or per-tag SLA overrides — one target per account,
  matching the existing dashboard setting.

## Current behavior

- `accounts.response_time_target_minutes` (migration 049): account-wide
  integer, surfaced via `useAuth().responseTimeTargetMinutes`.
- `src/lib/dashboard/queries.ts`'s `loadResponseTime()`: computes
  *historical averages* per weekday from the last 14 days of messages —
  this is a backward-looking aggregate query, not a live per-conversation
  clock. It doesn't currently track "how long has the *current* pending
  customer message in *this* conversation been waiting."
- `src/components/inbox/conversation-list.tsx`: no elapsed-wait
  indicator per row today — just last-message preview and timestamp.
- The pairing logic that identifies "a customer message still awaiting
  a reply" already exists in `loadResponseTime()`
  (`src/lib/dashboard/queries.ts` ~lines 200-224: walks messages per
  conversation, pairs an unreplied customer message with the next
  outbound one) — the live-inbox version needs the same shape of logic
  but evaluated in real time (no matching outbound message *yet*),
  not as a historical average.

## Proposed change

1. Add a lightweight computed value per open conversation: "minutes
   since the oldest unreplied inbound message," derived the same way
   `loadResponseTime()` finds `pendingCustomer` per conversation, but
   exposed live rather than only in the 14-day aggregate. Candidate
   approaches (pick one at implementation time, both have tradeoffs):
   - Compute client-side in `conversation-list.tsx` from data already
     fetched for the list (last message + its sender_type + timestamp),
     no new query — cheapest, but only knows about the *last* message,
     not whether an earlier unreplied one is actually still the oldest
     pending one in a back-and-forth.
   - A small dedicated query/view (`conversations` joined to the oldest
     unreplied `messages` row) for correctness — more work, matches the
     rigor `loadResponseTime()` already applies.
2. Render it as a small badge/timer on the conversation-list row and/or
   the thread header, color-coded against `responseTimeTargetMinutes`
   (e.g. neutral under target, amber approaching it, red past it) —
   reuse the badge-pill visual language already established (and just
   fixed for light/dark legibility) rather than inventing a new style.
3. Decide refresh cadence: a live "5m ago" ticking clock needs a timer,
   not just a one-time render — consider reusing the dashboard's
   already-added 2-minute background refresh pattern
   (`src/app/(dashboard)/dashboard/page.tsx`) or a lighter per-row
   `setInterval` tied to visibility.

## Acceptance criteria

- [ ] A conversation with an unanswered customer message past the
      account's `response_time_target_minutes` is visually
      distinguishable in the conversation list without opening it.
- [ ] The indicator clears/updates correctly the moment an agent (or
      the AI auto-reply) actually sends a reply — no stale "still
      waiting" badge after a response goes out.
- [ ] Changing the SLA target in Settings is reflected in the inbox
      without a full page reload (same `useAuth()` context value
      already used for the dashboard).

## Risks / open questions

- Performance: computing "oldest unreplied message per conversation"
  live, for a long conversation list, needs to not become an N+1 query
  — design the query (or client-side derivation) with that in mind
  from the start, unlike the dashboard's 14-day-window query which
  only runs once per dashboard load.
- Decide whether AI auto-replies count as "a reply" for SLA purposes
  the same way a human agent's message does, or whether the SLA is
  specifically about human response time (relevant given
  `src/lib/ai/handoff.ts`'s human-handoff rules already exist as a
  related concept).
