-- ============================================================
-- 108: a client account created from the operator portfolio is ready to
--      configure.
--
-- Since 106/107 a new account starts `pending` (must pay) and without
-- onboarded_at (must run the setup wizard). create_client_account sets the
-- operator as the owner, so entering the new client dropped the operator
-- into the client's onboarding and payment step with no way back to the
-- portfolio. A managed client is billed by the agency, not through the
-- self-service checkout, and the agency configures it from the dashboard,
-- so it is created exempt and already onboarded.
-- ============================================================

CREATE OR REPLACE FUNCTION create_client_account(p_name text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF agency_home_if_owner() IS NULL THEN
    RAISE EXCEPTION 'only the agency owner' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_name IS NULL OR length(btrim(p_name)) = 0 OR length(p_name) > 120 THEN
    RAISE EXCEPTION 'invalid name';
  END IF;
  INSERT INTO accounts (name, owner_user_id, managed_by, onboarded_at, subscription_status)
  VALUES (btrim(p_name), auth.uid(), auth.uid(), now(), 'exempt')
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
