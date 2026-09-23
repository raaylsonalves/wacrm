-- ============================================================
-- 060_ai_configs_agenda_tool.sql — opt-in flag letting the AI
-- auto-reply agent call the agenda tools (offer_slots /
-- book_appointment — specs/ai-agenda-tool-calling.md).
--
-- Off by default: an account with no appointment_settings configured
-- shouldn't suddenly have its bot offering to book things.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS agenda_enabled boolean NOT NULL DEFAULT false;
