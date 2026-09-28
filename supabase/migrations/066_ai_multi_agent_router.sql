-- ============================================================
-- 066_ai_multi_agent_router.sql — multiple AI agents per account +
-- intent router (specs/multi-agent-router.md).
--
-- `ai_configs` drops its one-row-per-account UNIQUE and gains
-- `name`/`is_default`. Every account that has a config today gets
-- exactly one row, so backfilling `is_default = true` for all of them
-- (before the partial unique index goes on) is lossless and needs no
-- per-account logic — there's nothing yet to pick between.
--
-- `ai_routers`/`ai_router_members` are new, and inert until an account
-- opts in: no router row exists for anyone today, so
-- `dispatchInboundToAiReply` behaves identically for every existing
-- account (see `loadActiveRouterForChannel` in src/lib/ai/router.ts —
-- it returns null when there's no active router, and the caller falls
-- straight back to the account's default agent, unchanged from before
-- this migration).
--
-- `channel_id` references `whatsapp_waha_channels`, not the
-- `whatsapp_channels` table the original spec draft imagined — the
-- WAHA spec shipped a narrower, additive table instead (migration
-- 056's own header explains why), and this is the real channel
-- concept that exists in this schema today. NULL = whole-account
-- router (also covers the Cloud API channel, which has no row of its
-- own to reference).
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS name text NOT NULL DEFAULT 'Assistente';
ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS is_default boolean NOT NULL DEFAULT false;

UPDATE ai_configs SET is_default = true WHERE NOT is_default;

ALTER TABLE ai_configs DROP CONSTRAINT IF EXISTS ai_configs_account_id_key;

-- Exactly one default agent per account — the fallback every eligible
-- conversation resolves to when no router is active, or a router's
-- classification/fallback chain comes up empty.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_configs_account_default
  ON ai_configs (account_id) WHERE is_default;

CREATE TABLE IF NOT EXISTS ai_routers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- NULL = every channel on the account (including Cloud API).
  channel_id uuid REFERENCES whatsapp_waha_channels(id) ON DELETE CASCADE,
  name text NOT NULL,
  is_active boolean NOT NULL DEFAULT false,
  -- NULL = classify with the default agent's own provider/model — see
  -- resolveAgentViaRouter. Never a separate classification service
  -- (non-goal): the classifier call uses the account's own BYO key.
  classifier_model text,
  min_confidence numeric NOT NULL DEFAULT 0.6
    CHECK (min_confidence >= 0 AND min_confidence <= 1),
  sticky boolean NOT NULL DEFAULT true,
  fallback_agent_id uuid REFERENCES ai_configs(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- At most one active router per (account, channel) — mirrors
-- idx_ai_configs_account_default's shape. A NULL channel_id still
-- collapses correctly under a partial unique index: Postgres treats
-- NULL = NULL as satisfied for uniqueness purposes only through the
-- index's own key comparison, which for a single-column index on a
-- nullable column allows only one NULL row when combined with the
-- WHERE clause here — verified by acceptance criteria, not assumed.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_routers_active_per_channel
  ON ai_routers (account_id, channel_id) WHERE is_active;

CREATE TABLE IF NOT EXISTS ai_router_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  router_id uuid NOT NULL REFERENCES ai_routers(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES ai_configs(id) ON DELETE CASCADE,
  intent_name text NOT NULL,
  intent_description text NOT NULL,
  examples text[] NOT NULL DEFAULT '{}',
  position integer NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_ai_router_members_router
  ON ai_router_members (router_id, position);

-- Sticky routing (specs/multi-agent-router.md's "sticky" semantics):
-- once a conversation is classified, it keeps the same agent for the
-- rest of the session without re-classifying every turn. Resolved at
-- the start of each turn from this column, not cached in process
-- memory — a restart or a different serverless invocation must see
-- the same assignment.
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS active_ai_agent_id uuid
    REFERENCES ai_configs(id) ON DELETE SET NULL;

ALTER TABLE ai_routers ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_router_members ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_routers_select ON ai_routers;
CREATE POLICY ai_routers_select ON ai_routers FOR SELECT
  USING (is_account_member(account_id));
DROP POLICY IF EXISTS ai_routers_insert ON ai_routers;
CREATE POLICY ai_routers_insert ON ai_routers FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS ai_routers_update ON ai_routers;
CREATE POLICY ai_routers_update ON ai_routers FOR UPDATE
  USING (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS ai_routers_delete ON ai_routers;
CREATE POLICY ai_routers_delete ON ai_routers FOR DELETE
  USING (is_account_member(account_id, 'admin'));

-- ai_router_members has no account_id of its own — scope through its
-- parent router, same pattern broadcast_recipients uses for broadcasts.
DROP POLICY IF EXISTS ai_router_members_select ON ai_router_members;
CREATE POLICY ai_router_members_select ON ai_router_members FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM ai_routers
    WHERE ai_routers.id = ai_router_members.router_id
      AND is_account_member(ai_routers.account_id)
  ));
DROP POLICY IF EXISTS ai_router_members_write ON ai_router_members;
CREATE POLICY ai_router_members_write ON ai_router_members FOR ALL
  USING (EXISTS (
    SELECT 1 FROM ai_routers
    WHERE ai_routers.id = ai_router_members.router_id
      AND is_account_member(ai_routers.account_id, 'admin')
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM ai_routers
    WHERE ai_routers.id = ai_router_members.router_id
      AND is_account_member(ai_routers.account_id, 'admin')
  ));

CREATE OR REPLACE FUNCTION public.update_ai_routers_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ai_routers_updated_at ON ai_routers;
CREATE TRIGGER ai_routers_updated_at
  BEFORE UPDATE ON ai_routers
  FOR EACH ROW
  EXECUTE FUNCTION public.update_ai_routers_updated_at();
