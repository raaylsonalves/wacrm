-- ============================================================
-- 128: handoff reason 'automated_sender' — the AI stops when the other
-- side is another company's bot (machine-speed or repeated long replies),
-- instead of looping with it. See lib/ai/automated-sender.ts.
-- ============================================================

ALTER TABLE conversations
  DROP CONSTRAINT IF EXISTS conversations_ai_handoff_reason_check;
ALTER TABLE conversations
  ADD CONSTRAINT conversations_ai_handoff_reason_check
  CHECK (ai_handoff_reason IS NULL OR ai_handoff_reason IN (
    'model_requested', 'reply_cap', 'provider_failure',
    'empty_reply', 'rate_limited', 'system_error',
    'customer_requested_human', 'audio_unintelligible', 'case_escalated',
    'flow_handoff', 'followup_exhausted', 'automated_sender'
  ));
