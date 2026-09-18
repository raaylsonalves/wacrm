# Spec: AI provider/model fallback chain with automatic human handoff

**Status: implemented.** Migration 052 has been applied to the live
Supabase project — the fallback chain is live. Shipped with one
fallback tier (not the 2 discussed as a cap) — the UI
(`ai-config.tsx`) exposes a single "fallback provider" section, but
the storage shape (`ai_configs.fallbacks`, a JSON array) and the chain
logic (`generate-with-fallback.ts`) both support more tiers without a
schema change; a second UI tier is a follow-up, not a redesign. Retry
count within a tier is 1 (2 attempts total, `RETRY_DELAYS_MS = [1500]`)
rather than the "1-2" range discussed — kept simple and fast-failing
for v1; `rate_limited` and `invalid_key` skip the retry entirely and
advance to the next tier immediately, per points 4 and the "never
retried" acceptance criterion. Migration `052_ai_provider_fallback_
chain.sql` adds `ai_configs.fallbacks jsonb NOT NULL DEFAULT '[]'`.
`loadAiConfig` and the `/api/ai/config` route both defensively degrade
(catch Postgres' `42703` undefined_column) to "no fallback configured"
if this column is ever missing again — e.g. code deployed ahead of the
migration in some other environment — so a timing mismatch there
doesn't take down every draft/auto-reply call.

The 7th point (quota cooldown) was left as the stretch goal it was
scoped as — not implemented in v1.

## Problem

`dispatchInboundToAiReply` (`src/lib/ai/auto-reply.ts`) calls exactly one
provider/model — whatever is saved in the account's AI config
(`loadAiConfig`) — through `generateReply` (`src/lib/ai/generate.ts`).
`generateReply` throws a typed `AiError` (`src/lib/ai/providers/shared.ts`:
`invalid_key` / `rate_limited` / `provider_error` / `timeout` /
`network_error`) on any non-2xx response or network failure, and
`dispatchInboundToAiReply` catches it at the top level (line ~214) and
just logs — by design, so a slow/broken LLM call never breaks the
webhook's 200 to Meta (see the doc comment on that function).

The consequence: a transient provider outage (e.g. Gemini's free tier
returning `503 — model is currently experiencing high demand`, or any
provider's `429` quota/rate limit) silently drops the auto-reply. No
retry, no fallback, no handoff, no notification — the conversation just
sits unanswered until the customer happens to send another message,
which re-runs the same single-provider call and can fail the same way
again. Reported by the account owner after seeing exactly this Gemini
503 in production logs.

## Non-goals

- Changing how a single provider call is made (timeout, headers, request
  shape) — this is purely about what happens *after* `generateReply`
  fails, not the call itself.
- A UI for arbitrarily many fallback tiers — two or three tiers (primary
  + 1-2 fallbacks) covers the actual failure modes (provider outage,
  provider quota) without turning AI config into a rules engine.
- Load-balancing or cost-optimization routing across providers during
  normal operation — the chain only activates on failure of the
  previous tier, it doesn't pick "cheapest model available now" when
  everything is healthy.
- Cross-account learning ("Gemini is down for everyone, skip it") — each
  account's chain reacts only to its own call outcomes. No shared
  circuit-breaker state.

## Current behavior

- `ai_config` (loaded by `loadAiConfig`, shape in `src/lib/ai/types.ts`)
  stores exactly one `{ provider, model, apiKey }` plus
  `handoffAgentId` (already used today — see `auto-reply.ts` lines
  159-181 — for the *content* handoff, when the model itself emits the
  `HANDOFF_SENTINEL` or returns empty text).
- `AiError.code` already distinguishes failure kinds worth routing on:
  `rate_limited` (429 — quota/rate), `provider_error` (5xx — outage),
  `timeout`, `network_error`, `invalid_key` (config problem, not
  transient — retrying or falling back won't help).
- `config.handoffAgentId` and the assignment logic in
  `dispatchInboundToAiReply` (lines 171-180) are the existing "give this
  conversation to a specific human" mechanism — reuse it verbatim for
  the failure-handoff path instead of inventing a second one.
- `buildHandoffSummary` (`src/lib/ai/handoff.ts`) composes the internal
  note left on content-handoff; extend it (or add a sibling builder)
  for the failure case rather than duplicating its truncation/quoting
  logic.

## Proposed change

1. **Config**: extend the AI config shape with an ordered list of
   fallback tiers, e.g. `fallbacks: { provider, model, apiKey }[]`
   (each tier is a full provider+model+key triple, since Gemini/OpenAI/
   Anthropic keys aren't interchangeable). Surface it in
   `ai-config.tsx` as an optional "if this fails, try..." section,
   reusing the existing provider/model/key fields per tier. Keep it
   capped at 2 fallback tiers (3 total attempts) — enough for
   "different provider" and "cheaper model on the same provider"
   without an open-ended list.
2. **Retry within a tier**: for `rate_limited`/`provider_error`/
   `timeout`/`network_error` only (never `invalid_key` — that's a
   config problem, not transient), retry the *same* tier once or twice
   with a short backoff (e.g. 1s, then 3s) before moving on. Total
   added latency must stay well under the customer's patience and
   Meta's own webhook timeout expectations — keep retries few and short.
3. **Tier advancement**: on exhausting retries for a tier (or
   immediately, for `rate_limited` specifically — see below — since
   retrying against a quota that's already exhausted just wastes the
   backoff window), move to the next configured fallback tier and call
   `generateReply` again with that tier's provider/model/key.
4. **Quota vs. outage distinction**: `rate_limited` (429) means "this
   key is out of quota/rate right now" — retrying the same tier
   immediately is pointless; skip straight to the next tier. `timeout`/
   `provider_error`/`network_error` are more likely transient blips —
   worth the short in-tier retry before advancing.
5. **Exhaustion → handoff**: if every configured tier (primary + all
   fallbacks) fails, fall through to the same handoff path
   `dispatchInboundToAiReply` already has for content-handoff (lines
   159-181): set `ai_autoreply_disabled = true`, assign
   `config.handoffAgentId` (if set and unassigned), and write an
   internal note. Add a new note-builder (e.g.
   `buildProviderFailureSummary`) distinct from
   `buildHandoffSummary`, since the cause is different information
   worth surfacing to the agent — e.g. "🤖 AI unavailable after trying
   2 providers (Gemini: rate limited, Claude: timeout) — transferred
   automatically."
6. **Usage logging**: call `logAiUsage` for whichever tier actually
   produced (or attempted) the final result, same as today — don't log
   failed attempts as spend, but consider a lightweight log line per
   failed tier for observability (the existing `console.error`/
   `console.warn` pattern in this file is enough; no new table needed
   for v1).
7. **Quota cooldown (stretch)**: when a tier fails with `rate_limited`,
   optionally remember (in-process, e.g. reusing the pattern in
   `src/lib/rate-limit.ts`) that this account+tier is "resting" for a
   few minutes, so the *next* inbound skips straight past it to the
   next tier instead of re-attempting a call that's certain to 429
   again. Not required for v1 — the per-call skip-on-429 already avoids
   wasting a retry — but worth flagging as the natural next step if
   quota exhaustion turns out to be frequent enough to matter.

## Acceptance criteria

- [ ] A primary-provider `503`/`429`/timeout no longer results in a
      silently unanswered conversation when at least one fallback tier
      is configured and healthy — the customer gets a reply from
      whichever tier succeeds.
- [ ] When every configured tier fails, the conversation is
      auto-assigned to `config.handoffAgentId` (or left in the shared
      queue if unset) with an internal note explaining which
      providers were tried and why each failed, exactly as content-
      handoff already does today for a different trigger.
- [ ] `invalid_key` on any tier is never retried and never blocks
      advancing to the next tier — a misconfigured key in the primary
      shouldn't prevent a working fallback from being tried.
- [ ] No fallback configured (today's default) behaves exactly as it
      does now — one attempt, then the existing catch-and-log — no
      regression for accounts that don't opt in.
- [ ] Total added latency from retries + tier advancement stays
      bounded (a hard ceiling, e.g. under ~10-15s end-to-end) so a
      fully-exhausted chain still hands off promptly rather than
      leaving the customer's typing indicator hanging.

## Risks / open questions

- Cost surprise: a fallback tier pointing at a paid provider means a
  Gemini outage silently starts spending the account's Anthropic/
  OpenAI key. Surface this clearly in the `ai-config.tsx` UI copy
  ("used automatically if your primary provider fails") so it's not a
  surprise on the bill.
- `logAiUsage`/`ai_usage` schema currently records one `{provider,
  model}` per reply (`auto-reply.ts` line ~154) — confirm it doesn't
  need to become plural to reflect "tried A, spent tokens on B."
  Likely fine as-is (log the tier that actually produced output), but
  worth a look during implementation.
- Total retry+fallback latency vs. Meta's webhook expectations and the
  `after()` execution window the webhook runs this in — needs a real
  timing budget, not just "make it retry."
- Decide whether `rate_limited` should immediately advance (per point 4
  above) or still get one fast retry — Gemini quota errors are usually
  hard (won't clear in 3 seconds), OpenAI/Anthropic 429s can sometimes
  be short bursts. May want to make this provider-aware rather than a
  single blanket rule.
