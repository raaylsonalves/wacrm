-- 092_agency_team.sql
--
-- The agency is the operator's home account (Nordia Tech), not one login.
-- The home account's owner can make teammates operators and choose which
-- client accounts each one may enter (operator_accounts, migration 090).
-- A teammate never sees a client they were not assigned, and the
-- portfolio counts-only rule still applies to them.

-- The caller's home account, only when they own it (else NULL).
CREATE OR REPLACE FUNCTION agency_home_if_owner()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT po.home_account_id
  FROM platform_operators po
  JOIN accounts a ON a.id = po.home_account_id
  WHERE po.user_id = auth.uid() AND a.owner_user_id = auth.uid();
$$;
REVOKE ALL ON FUNCTION agency_home_if_owner() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION agency_home_if_owner() TO authenticated;

-- Teammates of the agency: everyone whose home is that account, plus
-- members currently sitting in it, with the clients each may enter.
CREATE OR REPLACE FUNCTION agency_team()
RETURNS TABLE (user_id uuid, full_name text, email text, is_operator boolean, account_ids uuid[])
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_home uuid := agency_home_if_owner();
BEGIN
  IF v_home IS NULL THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT u.id, p.full_name, u.email::text,
         EXISTS (SELECT 1 FROM platform_operators po WHERE po.user_id = u.id),
         COALESCE((SELECT array_agg(oa.account_id) FROM operator_accounts oa WHERE oa.user_id = u.id), '{}')
  FROM auth.users u
  JOIN profiles p ON p.user_id = u.id
  WHERE u.id <> auth.uid()
    AND (p.account_id = v_home
         OR EXISTS (SELECT 1 FROM platform_operators po WHERE po.user_id = u.id AND po.home_account_id = v_home))
  ORDER BY p.full_name;
END;
$$;
REVOKE ALL ON FUNCTION agency_team() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION agency_team() TO authenticated;

-- Turn a teammate into an operator (or back into a plain member).
CREATE OR REPLACE FUNCTION set_agency_operator(p_user uuid, p_on boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_home uuid := agency_home_if_owner();
  v_role account_role_enum;
BEGIN
  IF v_home IS NULL THEN
    RAISE EXCEPTION 'only the agency owner' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_on THEN
    -- Must be a member of the agency: in it now, or already its operator.
    SELECT p.account_role INTO v_role FROM profiles p
     WHERE p.user_id = p_user AND p.account_id = v_home;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'not a member of the agency' USING ERRCODE = 'insufficient_privilege';
    END IF;
    INSERT INTO platform_operators (user_id, home_account_id, home_role)
    VALUES (p_user, v_home, v_role)
    ON CONFLICT (user_id) DO NOTHING;
  ELSE
    -- Refuse to strand a teammate inside a client account.
    IF EXISTS (SELECT 1 FROM profiles p WHERE p.user_id = p_user AND p.account_id <> v_home) THEN
      RAISE EXCEPTION 'operator is inside a client account' USING ERRCODE = 'check_violation';
    END IF;
    DELETE FROM platform_operators WHERE user_id = p_user AND home_account_id = v_home;
  END IF;
  INSERT INTO audit_log (account_id, actor_user_id, action, resource_type, resource_id, metadata)
  VALUES (v_home, auth.uid(), 'agency.operator_' || CASE WHEN p_on THEN 'added' ELSE 'removed' END,
          'user', p_user, '{}'::jsonb);
END;
$$;
REVOKE ALL ON FUNCTION set_agency_operator(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION set_agency_operator(uuid, boolean) TO authenticated;

-- Give a teammate access to one client, or take it away.
CREATE OR REPLACE FUNCTION set_operator_assignment(p_user uuid, p_account uuid, p_on boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_home uuid := agency_home_if_owner();
BEGIN
  IF v_home IS NULL THEN
    RAISE EXCEPTION 'only the agency owner' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Target must be an operator of this agency, and the client one the
  -- owner manages.
  IF NOT EXISTS (SELECT 1 FROM platform_operators WHERE user_id = p_user AND home_account_id = v_home)
     OR NOT EXISTS (SELECT 1 FROM operator_accounts WHERE user_id = auth.uid() AND account_id = p_account) THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_on THEN
    INSERT INTO operator_accounts (user_id, account_id, role) VALUES (p_user, p_account, 'admin')
    ON CONFLICT DO NOTHING;
  ELSE
    -- If they are inside that client right now, send them home first.
    UPDATE profiles p SET account_id = po.home_account_id, account_role = po.home_role
      FROM platform_operators po
     WHERE po.user_id = p_user AND p.user_id = p_user AND p.account_id = p_account;
    DELETE FROM operator_accounts WHERE user_id = p_user AND account_id = p_account;
  END IF;
  INSERT INTO audit_log (account_id, actor_user_id, action, resource_type, resource_id, metadata)
  VALUES (p_account, auth.uid(), 'agency.assignment_' || CASE WHEN p_on THEN 'added' ELSE 'removed' END,
          'user', p_user, '{}'::jsonb);
END;
$$;
REVOKE ALL ON FUNCTION set_operator_assignment(uuid, uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION set_operator_assignment(uuid, uuid, boolean) TO authenticated;

-- Only the agency owner creates client accounts; a teammate operator
-- would otherwise end up as the client's owner.
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
