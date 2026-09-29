-- ============================================================
-- 069_channel_routing_responsibles.sql — per-channel responsible
-- agents (specs/channel-routing-responsibles.md).
--
-- `channel_routing_policies` gates who a conversation can be
-- assigned to, keyed by channel: NULL `waha_channel_id` = the
-- account's Cloud API number (same NULL-means-Cloud-API convention
-- `conversations.whatsapp_channel_id` established in migration 056).
-- No policy row for a channel = unrestricted (every account member
-- eligible) — an account that never touches this feature sees zero
-- behavior change. A policy row with zero `channel_routing_responsibles`
-- rows = "restricted_empty": an explicit "nobody owns this number yet"
-- state, distinct from unrestricted.
--
-- Enforcement is a trigger on `conversations`, not app code alone —
-- the acceptance criteria require that a 3rd, ineligible member can't
-- be assigned "even by forging the request", and dashboard writes go
-- straight from the browser through RLS with no server hop to
-- intercept. The trigger only fires when `assigned_agent_id` actually
-- changes to a non-NULL value, so an existing assignment that becomes
-- ineligible after the fact is grandfathered (per the spec's own
-- recommendation), and unassigning is always allowed.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS channel_routing_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  waha_channel_id uuid UNIQUE REFERENCES whatsapp_waha_channels(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- At most one policy per account with waha_channel_id IS NULL (the
-- Cloud API slot) — a plain UNIQUE constraint on the column can't
-- express "unique among NULLs", Postgres treats every NULL as distinct.
CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_routing_policies_cloud_api
  ON channel_routing_policies (account_id) WHERE waha_channel_id IS NULL;

CREATE TABLE IF NOT EXISTS channel_routing_responsibles (
  policy_id uuid NOT NULL REFERENCES channel_routing_policies(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  PRIMARY KEY (policy_id, user_id)
);

ALTER TABLE channel_routing_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_routing_responsibles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS channel_routing_policies_select ON channel_routing_policies;
CREATE POLICY channel_routing_policies_select ON channel_routing_policies FOR SELECT
  USING (is_account_member(account_id));
DROP POLICY IF EXISTS channel_routing_policies_write ON channel_routing_policies;
CREATE POLICY channel_routing_policies_write ON channel_routing_policies FOR ALL
  USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));

-- No account_id of its own — scope through the parent policy, same
-- pattern ai_router_members uses for ai_routers (migration 066) and
-- broadcast_channel_pool uses for broadcasts (migration 068).
DROP POLICY IF EXISTS channel_routing_responsibles_select ON channel_routing_responsibles;
CREATE POLICY channel_routing_responsibles_select ON channel_routing_responsibles FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM channel_routing_policies
    WHERE channel_routing_policies.id = channel_routing_responsibles.policy_id
      AND is_account_member(channel_routing_policies.account_id)
  ));
DROP POLICY IF EXISTS channel_routing_responsibles_write ON channel_routing_responsibles;
CREATE POLICY channel_routing_responsibles_write ON channel_routing_responsibles FOR ALL
  USING (EXISTS (
    SELECT 1 FROM channel_routing_policies
    WHERE channel_routing_policies.id = channel_routing_responsibles.policy_id
      AND is_account_member(channel_routing_policies.account_id, 'admin')
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM channel_routing_policies
    WHERE channel_routing_policies.id = channel_routing_responsibles.policy_id
      AND is_account_member(channel_routing_policies.account_id, 'admin')
  ));

CREATE OR REPLACE FUNCTION enforce_channel_routing_assignment()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_policy_id uuid;
  v_eligible boolean;
BEGIN
  -- Unassigning is always allowed; a no-op assignment (grandfathered
  -- rows, or any other column changing on the row) never re-checks.
  IF NEW.assigned_agent_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.assigned_agent_id IS NOT DISTINCT FROM OLD.assigned_agent_id THEN
    RETURN NEW;
  END IF;

  SELECT id INTO v_policy_id
  FROM channel_routing_policies
  WHERE account_id = NEW.account_id
    AND waha_channel_id IS NOT DISTINCT FROM NEW.whatsapp_channel_id;

  IF v_policy_id IS NULL THEN
    RETURN NEW; -- unrestricted
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM channel_routing_responsibles
    WHERE policy_id = v_policy_id AND user_id = NEW.assigned_agent_id
  ) INTO v_eligible;

  IF NOT v_eligible THEN
    RAISE EXCEPTION 'assigned_agent_id is not eligible for this channel''s routing policy'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_channel_routing ON conversations;
CREATE TRIGGER trg_enforce_channel_routing
  BEFORE UPDATE ON conversations
  FOR EACH ROW
  EXECUTE FUNCTION enforce_channel_routing_assignment();
