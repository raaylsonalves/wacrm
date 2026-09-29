-- ============================================================
-- 077_ai_transcription_model.sql — which model transcribes the voice
-- notes this agent receives (specs/ai-voice-replies.md, phase 1).
--
-- NULL = the built-in default. The value is validated against an
-- allow-list in the app (a new model needs no migration), so there is
-- deliberately no CHECK here.
--
-- Additive and idempotent.
-- ============================================================
ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS transcription_model text;
