-- ============================================================
-- Operator mode v1 (specs/operator-multi-account.md)
-- ============================================================
-- One person (a platform operator) runs several client accounts from one
-- login. v1 is deliberately narrow:
--
--   * `platform_operators` — who may operate at all. Seeded with a single
--     user; nobody else sees any of this.
--   * `operator_accounts` — the client accounts an operator may enter,
--     always with role admin (never owner of a client's account in the
--     role sense; see below).
--   * `switch_account` — the ONLY way the active account changes: it
--     rewrites profiles.account_id/account_role (so every RLS policy and
--     getCurrentAccount keep working untouched) and writes audit_log in
--     the account entered. Going home is allowed only to the operator's
--     recorded home account.
--   * `create_client_account` — a fresh account for a client, the
--     operator as owner_user_id (NOT NULL) until ownership is transferred
--     with the existing transfer flow, and an operator grant.
--   * `operator_portfolio` — counts and health per client, never message
--     or contact content.
--
-- Not in v1: client-initiated grants/revocation, the "essential" UI
-- profile, remote connect links, and the stale-tab header check.

CREATE TABLE IF NOT EXISTS platform_operators (
  user_id         uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  -- Where "back to my account" goes.
  home_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  home_role       account_role_enum NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE platform_operators ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS platform_operators_self ON platform_operators;
CREATE POLICY platform_operators_self ON platform_operators FOR SELECT
  USING (auth.uid() = user_id);

CREATE TABLE IF NOT EXISTS operator_accounts (
  user_id    uuid NOT NULL REFERENCES platform_operators(user_id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  role       account_role_enum NOT NULL DEFAULT 'admin' CHECK (role IN ('admin', 'agent')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, account_id)
);
ALTER TABLE operator_accounts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS operator_accounts_self ON operator_accounts;
CREATE POLICY operator_accounts_self ON operator_accounts FOR SELECT
  USING (auth.uid() = user_id);

-- Seed: the single operator, home = their current account.
INSERT INTO platform_operators (user_id, home_account_id, home_role)
SELECT u.id, p.account_id, p.account_role
  FROM auth.users u
  JOIN profiles p ON p.user_id = u.id
 WHERE u.email = 'raaylsonalvesp@gmail.com'
ON CONFLICT (user_id) DO NOTHING;

-- ---- managed client accounts ------------------------------------------
-- A client account the operator creates is owned by the operator
-- (owner_user_id is NOT NULL) until ownership is handed over. The
-- one-account-per-owner rule (017) stays for every account a person signs
-- up for; it just doesn't count the accounts an operator manages.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS managed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;
DROP INDEX IF EXISTS idx_accounts_one_per_owner;
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_one_per_owner
  ON accounts(owner_user_id) WHERE managed_by IS NULL;

-- ---- switch --------------------------------------------------------
CREATE OR REPLACE FUNCTION switch_account(p_account uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_op platform_operators%ROWTYPE;
  v_role account_role_enum;
  v_from uuid;
BEGIN
  SELECT * INTO v_op FROM platform_operators WHERE user_id = auth.uid();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not an operator' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_account = v_op.home_account_id THEN
    v_role := v_op.home_role;
  ELSE
    SELECT role INTO v_role FROM operator_accounts
     WHERE user_id = auth.uid() AND account_id = p_account;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'no access to that account' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;

  SELECT account_id INTO v_from FROM profiles WHERE user_id = auth.uid();
  UPDATE profiles SET account_id = p_account, account_role = v_role
   WHERE user_id = auth.uid();

  -- Visible to the entered account's admins: an operator is in the room.
  INSERT INTO audit_log (account_id, actor_user_id, action, resource_type, resource_id, metadata)
  VALUES (p_account, auth.uid(), 'operator.account_switch', 'account', p_account,
          jsonb_build_object('from_account', v_from));
  RETURN p_account;
END;
$$;
ALTER FUNCTION switch_account(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION switch_account(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION switch_account(uuid) TO authenticated;

-- ---- create a client account ----------------------------------------
CREATE OR REPLACE FUNCTION create_client_account(p_name text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM platform_operators WHERE user_id = auth.uid()) THEN
    RAISE EXCEPTION 'not an operator' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_name IS NULL OR length(btrim(p_name)) = 0 OR length(p_name) > 120 THEN
    RAISE EXCEPTION 'invalid name';
  END IF;
  INSERT INTO accounts (name, owner_user_id, managed_by) VALUES (btrim(p_name), auth.uid(), auth.uid())
  RETURNING id INTO v_id;
  INSERT INTO operator_accounts (user_id, account_id, role) VALUES (auth.uid(), v_id, 'admin');
  INSERT INTO audit_log (account_id, actor_user_id, action, resource_type, resource_id, metadata)
  VALUES (v_id, auth.uid(), 'operator.account_created', 'account', v_id, '{}'::jsonb);
  RETURN v_id;
END;
$$;
ALTER FUNCTION create_client_account(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION create_client_account(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION create_client_account(text) TO authenticated;

-- ---- portfolio --------------------------------------------------------
-- Health and counts only. No message text, no contact names or phones.
CREATE OR REPLACE FUNCTION operator_portfolio()
RETURNS TABLE (
  account_id uuid,
  name text,
  is_home boolean,
  is_active boolean,
  owner_is_operator boolean,
  meta_status text,
  waha_total int,
  waha_down int,
  ai_on boolean,
  awaiting_reply int,
  handoff_waiting int,
  open_cases int,
  appointments_today int,
  tokens_7d bigint,
  last_inbound_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_op platform_operators%ROWTYPE;
  v_active uuid;
BEGIN
  SELECT * INTO v_op FROM platform_operators WHERE user_id = auth.uid();
  IF NOT FOUND THEN
    RETURN;
  END IF;
  SELECT p.account_id INTO v_active FROM profiles p WHERE p.user_id = auth.uid();

  RETURN QUERY
  WITH mine AS (
    SELECT v_op.home_account_id AS id
    UNION
    SELECT oa.account_id FROM operator_accounts oa WHERE oa.user_id = auth.uid()
  )
  SELECT
    a.id,
    COALESCE(NULLIF(a.display_name, ''), a.name),
    a.id = v_op.home_account_id,
    a.id = v_active,
    a.owner_user_id = auth.uid() AND a.id <> v_op.home_account_id,
    (SELECT wc.status FROM whatsapp_config wc WHERE wc.account_id = a.id LIMIT 1),
    (SELECT count(*)::int FROM whatsapp_waha_channels w WHERE w.account_id = a.id),
    (SELECT count(*)::int FROM whatsapp_waha_channels w WHERE w.account_id = a.id AND w.status <> 'connected'),
    EXISTS (SELECT 1 FROM ai_configs ac WHERE ac.account_id = a.id AND ac.is_active AND ac.auto_reply_enabled),
    (SELECT count(*)::int FROM conversations c
      WHERE c.account_id = a.id AND c.status <> 'closed' AND c.last_message_sender_type = 'customer'),
    (SELECT count(*)::int FROM conversations c
      WHERE c.account_id = a.id AND c.status <> 'closed' AND c.ai_autoreply_disabled AND c.assigned_agent_id IS NULL),
    (SELECT count(*)::int FROM human_cases h WHERE h.account_id = a.id AND h.status = 'awaiting_human'),
    (SELECT count(*)::int FROM appointments ap
      WHERE ap.account_id = a.id AND ap.status IN ('scheduled', 'confirmed')
        AND (ap.starts_at AT TIME ZONE COALESCE(
              (SELECT s.timezone FROM appointment_settings s WHERE s.account_id = a.id), 'America/Sao_Paulo'))::date
          = (now() AT TIME ZONE COALESCE(
              (SELECT s.timezone FROM appointment_settings s WHERE s.account_id = a.id), 'America/Sao_Paulo'))::date),
    (SELECT COALESCE(sum(u.total_tokens), 0)::bigint FROM ai_usage_log u
      WHERE u.account_id = a.id AND u.created_at > now() - interval '7 days'),
    (SELECT max(c.last_customer_message_at) FROM conversations c WHERE c.account_id = a.id)
  FROM accounts a
  JOIN mine ON mine.id = a.id;
END;
$$;
ALTER FUNCTION operator_portfolio() OWNER TO postgres;
REVOKE ALL ON FUNCTION operator_portfolio() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION operator_portfolio() TO authenticated;
