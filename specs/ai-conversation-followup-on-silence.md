# Spec: AI follow-up message after customer silence

## Problem

Once the AI auto-reply bot sends a message and the customer doesn't
answer, the conversation just sits there forever — nothing ever nudges
the customer again. For a loan-broker use case (Agius) this is a real
lead-loss path: a customer who was mid-qualification (already gave a
name, maybe started answering questions) and got distracted never
hears from the business again unless a human happens to notice the
stale conversation in the inbox.

This came up explicitly in `specs/agius-ai-prompt.md`'s "Limitação
conhecida" note: the bot only reacts to inbound messages
(`dispatchInboundToAiReply` in `src/lib/ai/auto-reply.ts` runs from the
WhatsApp webhook's `after()` block) — there is no code path that fires
on the *absence* of an inbound message.

## Non-goals

- General "re-engagement campaigns" / marketing drip sequences for old
  contacts — this is specifically about a conversation the AI bot was
  actively having and that went quiet mid-flow, not a broadcast to a
  cold list. Broadcasts already exist as their own feature
  (`src/lib/broadcasts/`).
- Multiple follow-up attempts with increasing intervals ("nudge at 1h,
  then 6h, then 24h") — v1 sends exactly one follow-up per silence
  episode. A backoff sequence is a bigger feature (needs its own state
  machine) and isn't needed to solve the immediate lead-loss problem.
- Following up after a *human* agent's message goes unanswered — a
  human already sees the conversation in their inbox and can decide to
  follow up themselves; this spec is scoped to AI-driven conversations
  only (`assigned_agent_id IS NULL`, same eligibility gate auto-reply
  itself uses).
- Changing WhatsApp's 24h customer-service-window rules. A follow-up
  sent outside the 24h window from the customer's last message would
  need an approved template, not a freeform session message — see
  "Risks" below.

## Current behavior

- `dispatchInboundToAiReply` (`src/lib/ai/auto-reply.ts:93`) is the
  only entry point that generates an AI reply. It runs once, inline,
  per inbound webhook event. Nothing schedules future work from it.
- The account-level automations engine (`src/lib/automations/`,
  migration 006) already has a durable delay primitive: a `Wait` step
  parks a row in `automation_pending_executions` with a `resume_at`
  timestamp, drained by `GET /api/automations/cron` on a schedule
  (shared secret via `x-cron-secret`). But automations trigger on
  events (`new_message_received`, `keyword_match`, `tag_added`,
  `interactive_reply`, `first_inbound_message`, `schedule`) — there is
  no trigger type for "N hours passed with no reply on a conversation
  the AI was driving."
- `conversations` (migration 001, extended by 031's
  `ai_reply_count`/`ai_autoreply_disabled` columns) has no column
  tracking "AI sent the last message at time T and is waiting."

## Proposed change

1. **New column**: `conversations.ai_awaiting_reply_since TIMESTAMPTZ
   NULL`. Set to `now()` every time `dispatchInboundToAiReply`
   successfully sends a reply (end of the segment-send loop in
   `auto-reply.ts`); cleared (`NULL`) whenever a new inbound message
   arrives for that conversation (webhook already touches the
   `conversations` row on every inbound — add the clear there) and
   whenever the conversation is handed off / assigned / auto-reply
   disabled (the existing `handOffToHuman` update already touches the
   row — add it there too, and to any other assignment path).

2. **New per-account setting** in `ai_configs` (alongside
   `auto_reply_max_per_conversation`):
   `followup_enabled BOOLEAN NOT NULL DEFAULT false` and
   `followup_delay_minutes INTEGER NOT NULL DEFAULT 180` (3h) — off by
   default so existing accounts don't suddenly start messaging idle
   customers.

3. **New cron-drained job**, mirroring the automations cron's shape
   (`GET /api/ai/followup/cron`, same `x-cron-secret` check as
   `/api/automations/cron`): finds conversations where
   `ai_awaiting_reply_since IS NOT NULL`, `ai_awaiting_reply_since <
   now() - followup_delay_minutes`, `assigned_agent_id IS NULL`,
   `ai_autoreply_disabled = false`, and the account's
   `followup_enabled = true`, and that haven't already received a
   follow-up for this silence episode (add
   `ai_followup_sent_at TIMESTAMPTZ NULL` to `conversations`, cleared
   alongside `ai_awaiting_reply_since`, checked `IS NULL` in the
   query). For each match:
   - Generate a short, natural nudge — not a second full LLM call by
     default; a small fixed set of rotating template lines (in the
     account's configured tone, picked account-side, not by the LLM)
     is enough for v1 and avoids doubling AI spend on every idle
     conversation. Fill in the customer's name if known. (An
     LLM-generated nudge referencing the specific stalled topic is a
     reasonable v2 if the fixed lines feel too generic in practice.)
   - Send via the same `engineSendText` path auto-reply already uses,
     `aiGenerated: true`.
   - Set `ai_followup_sent_at = now()`.
4. **No second nudge, no auto-handoff on continued silence** for v1
   (see Non-goals) — if the customer still doesn't answer after the
   one follow-up, the conversation just sits, same as today, until a
   human notices or the customer replies (which clears
   `ai_awaiting_reply_since`/`ai_followup_sent_at` and lets a future
   silence episode fire a follow-up again).
5. **Settings UI**: a toggle + delay field in the existing AI config
   card (`src/components/settings/ai-config.tsx`), next to the reply
   cap field.

## Acceptance criteria

- [ ] Migration adds `conversations.ai_awaiting_reply_since`,
      `conversations.ai_followup_sent_at`, and
      `ai_configs.followup_enabled` / `ai_configs.followup_delay_minutes`,
      with `verify-schema.sql` updated.
- [ ] `ai_awaiting_reply_since` is set on every AI-sent reply and
      cleared on the next inbound message and on any handoff/assignment.
- [ ] `/api/ai/followup/cron` sends exactly one nudge per silence
      episode, only for accounts with `followup_enabled = true`, only
      for AI-owned unassigned conversations, and never for a
      conversation whose cap was already reached / that was handed off.
- [ ] Settings UI can toggle the feature and set the delay per account.
- [ ] A conversation that gets a customer reply before the delay
      elapses never receives a follow-up for that episode.

## Risks / open questions

- **24h session window**: WhatsApp only allows freeform (non-template)
  messages within 24h of the customer's last inbound message. If
  `followup_delay_minutes` is configured close to or past 24h, the
  send will be rejected by Meta unless it's sent as an approved
  template. v1 should either cap the configurable delay well under 24h
  in the UI, or detect the 24h-elapsed case and skip (log, don't
  crash) rather than attempt a doomed freeform send — needs a decision
  before implementing.
- **Multiple AI-owned conversations paging in at once**: this job scans
  across accounts like the automations cron does — same "single Node
  process" rate-limiting caveat already documented in
  `lib/rate-limit.ts` applies; reuse `RATE_LIMITS.aiAutoReplyAccount`
  or a dedicated limiter so a burst of due follow-ups can't blow past
  the account's provider rate limit.
- Should a follow-up count against `auto_reply_max_per_conversation`?
  Leaning yes (it's still an AI-initiated message occupying the
  customer's attention) — worth confirming with the account owner
  before implementing, since it changes how soon the cap is reached on
  a conversation that also got nudged.
