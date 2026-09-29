-- ============================================================
-- 079_ai_voice_replies.sql — answer a voice note with a voice note
-- (specs/ai-voice-replies.md, phase 2).
--
--   voice_reply_mode: 'off' (default) | 'mirror' (voice only when the
--                     customer's message was audio).
--   voice_name:       the TTS voice; NULL = default. Allow-listed in the
--                     app (src/lib/ai/voice-reply.ts), like the
--                     transcription model.
--
-- Additive and idempotent.
-- ============================================================
ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS voice_reply_mode text NOT NULL DEFAULT 'off',
  ADD COLUMN IF NOT EXISTS voice_name text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ai_configs_voice_reply_mode_check'
  ) THEN
    ALTER TABLE ai_configs
      ADD CONSTRAINT ai_configs_voice_reply_mode_check
      CHECK (voice_reply_mode IN ('off', 'mirror'));
  END IF;
END
$$;
