-- ============================================================
-- Add 'openrouter' as a valid AI provider.
--
-- Same pattern as 050 (adding 'gemini'): both ai_configs and
-- ai_usage_log CHECK-constrain `provider`. Drop & re-add each with
-- 'openrouter' added — Postgres has no `ALTER CONSTRAINT ... ADD
-- VALUE` for a plain CHECK, only for enums.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE ai_configs
  DROP CONSTRAINT IF EXISTS ai_configs_provider_check;

ALTER TABLE ai_configs
  ADD CONSTRAINT ai_configs_provider_check
  CHECK (provider IN ('openai', 'anthropic', 'gemini', 'openrouter'));

ALTER TABLE ai_usage_log
  DROP CONSTRAINT IF EXISTS ai_usage_log_provider_check;

ALTER TABLE ai_usage_log
  ADD CONSTRAINT ai_usage_log_provider_check
  CHECK (provider IN ('openai', 'anthropic', 'gemini', 'openrouter'));
