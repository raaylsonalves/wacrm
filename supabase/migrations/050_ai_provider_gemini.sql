-- ============================================================
-- Add 'gemini' as a valid AI provider (specs/ai-provider-gemini.md).
--
-- Both ai_configs (029) and ai_usage_log (033) CHECK-constrain
-- `provider` to ('openai', 'anthropic'). Drop & re-add each with
-- 'gemini' added — Postgres has no `ALTER CONSTRAINT ... ADD VALUE`
-- for a plain CHECK, only for enums.
-- ============================================================

ALTER TABLE ai_configs
  DROP CONSTRAINT IF EXISTS ai_configs_provider_check;

ALTER TABLE ai_configs
  ADD CONSTRAINT ai_configs_provider_check
  CHECK (provider IN ('openai', 'anthropic', 'gemini'));

ALTER TABLE ai_usage_log
  DROP CONSTRAINT IF EXISTS ai_usage_log_provider_check;

ALTER TABLE ai_usage_log
  ADD CONSTRAINT ai_usage_log_provider_check
  CHECK (provider IN ('openai', 'anthropic', 'gemini'));
