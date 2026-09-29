-- ============================================================
-- 080_ai_usage_kinds.sql — voice costs on the Usage tab
-- (specs/ai-voice-replies.md).
--
--   kind:         'chat' (every row before this) | 'transcription' |
--                 'speech'. Kept apart so chat totals stay comparable
--                 and audio spend is visible on its own.
--   speech_chars: characters sent to text-to-speech (billed that way;
--                 the speech endpoint returns no token count).
--
-- Additive and idempotent.
-- ============================================================
ALTER TABLE ai_usage_log
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'chat',
  ADD COLUMN IF NOT EXISTS speech_chars integer;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ai_usage_log_kind_check'
  ) THEN
    ALTER TABLE ai_usage_log
      ADD CONSTRAINT ai_usage_log_kind_check
      CHECK (kind IN ('chat', 'transcription', 'speech'));
  END IF;
END
$$;
