-- ============================================================
-- 124: two more reasons the AI steps out of a conversation
-- (specs/review-2026-10.md A8, A12):
--   flow_handoff        a Flow reached a handoff node (or ran out of
--                       fallbacks) — the AI used to keep answering the
--                       next message and nobody was told;
--   followup_exhausted  a follow-up sequence ended without a reply and its
--                       "on exhaust" action hands off to a person.
-- The inbox banner and the notifications render them like the others.
-- ============================================================

ALTER TABLE conversations
  DROP CONSTRAINT IF EXISTS conversations_ai_handoff_reason_check;
ALTER TABLE conversations
  ADD CONSTRAINT conversations_ai_handoff_reason_check
  CHECK (ai_handoff_reason IS NULL OR ai_handoff_reason IN (
    'model_requested', 'reply_cap', 'provider_failure',
    'empty_reply', 'rate_limited', 'system_error',
    'customer_requested_human', 'audio_unintelligible', 'case_escalated',
    'flow_handoff', 'followup_exhausted'
  ));
