-- ============================================================
-- 052_ai_provider_fallback_chain.sql — AI provider/model fallback
-- chain (specs/ai-provider-fallback-chain.md).
--
-- `ai_configs.fallbacks` is an ordered JSON array of
-- `{ provider, model, api_key }` triples, each `api_key` AES-256-GCM
-- encrypted the same way as the primary `api_key` column (see 029).
-- Kept as JSONB rather than a child table: it's always read/written
-- whole (the whole ordered chain, together) and never queried by its
-- contents, so a table + FK + ordering column would only add joins
-- with no benefit. Empty array (the default) means "no fallback
-- configured" — auto-reply behaves exactly as it did before this
-- migration.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS fallbacks jsonb NOT NULL DEFAULT '[]'::jsonb;
