-- ============================================================
-- 074_ai_agent_management.sql — manageable AI agents
-- (specs/ai-agents-management.md).
--
--   1. ai_channel_agents — which agent answers on which NUMBER. Until
--      now a non-default agent only ever ran through a router's
--      intents; a small business with two numbers (or an operator
--      running several clients) needs "this number → this agent"
--      without building a classifier. NULL channel_id = the Cloud API
--      number (the repo-wide NULL-means-Cloud-API convention).
--   2. ai_usage_log.agent_id — usage per agent, not just per account.
--   3. ai_configs.handoff_keywords — a deterministic "get me a person"
--      path that never spends a token.
--
-- Additive: an account that touches none of it behaves exactly as before
-- (no binding → router → default agent, as today).
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ---- 1. Agent per number ------------------------------------------
CREATE TABLE IF NOT EXISTS ai_channel_agents (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- NULL = the account's Cloud API number.
  channel_id uuid REFERENCES whatsapp_waha_channels(id) ON DELETE CASCADE,
  agent_id   uuid NOT NULL REFERENCES ai_configs(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- One agent per number. coalesce() so the Cloud API slot (NULL) is
-- unique too — a plain UNIQUE treats NULLs as distinct.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_channel_agents_channel
  ON ai_channel_agents (
    account_id,
    coalesce(channel_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );
CREATE INDEX IF NOT EXISTS idx_ai_channel_agents_agent
  ON ai_channel_agents (agent_id);

-- The agent and the channel must belong to the row's own account: the
-- dashboard writes this table straight through RLS, and a forged
-- agent_id from another account would otherwise bind a foreign agent
-- (and its key) to this account's number.
CREATE OR REPLACE FUNCTION public.check_ai_channel_agent_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM ai_configs a
    WHERE a.id = NEW.agent_id AND a.account_id = NEW.account_id
  ) THEN
    RAISE EXCEPTION 'agent does not belong to this account'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.channel_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM whatsapp_waha_channels c
    WHERE c.id = NEW.channel_id AND c.account_id = NEW.account_id
  ) THEN
    RAISE EXCEPTION 'channel does not belong to this account'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_ai_channel_agent_scope ON ai_channel_agents;
CREATE TRIGGER trg_ai_channel_agent_scope
  BEFORE INSERT OR UPDATE ON ai_channel_agents
  FOR EACH ROW EXECUTE FUNCTION public.check_ai_channel_agent_scope();

ALTER TABLE ai_channel_agents ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_channel_agents_select ON ai_channel_agents;
CREATE POLICY ai_channel_agents_select ON ai_channel_agents
  FOR SELECT USING (is_account_member(account_id));
DROP POLICY IF EXISTS ai_channel_agents_modify ON ai_channel_agents;
CREATE POLICY ai_channel_agents_modify ON ai_channel_agents
  FOR ALL USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));

-- ---- 2. Usage per agent -------------------------------------------
-- ON DELETE SET NULL: deleting an agent keeps its historical spend
-- (shown as "agente anterior"); the totals must not shrink.
ALTER TABLE ai_usage_log
  ADD COLUMN IF NOT EXISTS agent_id uuid
    REFERENCES ai_configs(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_ai_usage_log_agent_created
  ON ai_usage_log (agent_id, created_at DESC);

-- ---- 3. Deterministic handoff keywords -----------------------------
ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS handoff_keywords text[] NOT NULL DEFAULT '{}';
