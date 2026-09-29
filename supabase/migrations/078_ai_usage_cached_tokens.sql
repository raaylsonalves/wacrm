-- ============================================================
-- 078_ai_usage_cached_tokens.sql — how much of each prompt the provider
-- served from its cache (specs/ai-token-economy.md, lever 3).
--
-- NULL means the provider did not report it — NOT zero. Keeping the two
-- apart is what lets the Usage screen say "not reported" instead of
-- claiming a 0% cache rate it never measured.
--
-- Additive and idempotent.
-- ============================================================
ALTER TABLE ai_usage_log
  ADD COLUMN IF NOT EXISTS cached_tokens integer;
