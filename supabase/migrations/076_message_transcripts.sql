-- ============================================================
-- 076_message_transcripts.sql — answer customers who send voice notes
-- (specs/ai-audio-inbound.md).
--
--   1. messages.transcript / transcript_status — what the customer said in
--      an audio message, written by the AI path when it transcribes it.
--      Kept apart from content_text on purpose: content_text is what the
--      inbox and the conversation list show as the message itself, and a
--      machine transcript must not pass for the customer's own words.
--   2. conversations.ai_handoff_reason gains 'audio_unintelligible' — the
--      customer sent audio twice and the assistant could not make it out.
--
-- Additive and idempotent.
-- ============================================================

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS transcript text,
  ADD COLUMN IF NOT EXISTS transcript_status text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.messages'::regclass
      AND conname = 'messages_transcript_status_check'
  ) THEN
    ALTER TABLE messages
      ADD CONSTRAINT messages_transcript_status_check
      CHECK (transcript_status IS NULL OR transcript_status IN ('done', 'failed'));
  END IF;
END
$$;

-- Widen the handoff-reason CHECK (072). Dropped and re-added by name:
-- a CHECK cannot be altered in place.
ALTER TABLE conversations
  DROP CONSTRAINT IF EXISTS conversations_ai_handoff_reason_check;
ALTER TABLE conversations
  ADD CONSTRAINT conversations_ai_handoff_reason_check
  CHECK (ai_handoff_reason IS NULL OR ai_handoff_reason IN (
    'model_requested', 'reply_cap', 'provider_failure',
    'empty_reply', 'rate_limited', 'system_error',
    'customer_requested_human', 'audio_unintelligible'
  ));
