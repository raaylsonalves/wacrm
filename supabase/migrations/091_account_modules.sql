-- 091_account_modules.sql
--
-- What a client account bought. An agency (operator, migration 090) sells
-- pieces of the CRM — "só automação", "só inbox e agenda" — and the
-- client's own users should see only what they bought, while the agency
-- operating the account keeps seeing everything.
--
--   accounts.modules — NULL means "everything" (every account that is not
--   agency-managed keeps working as before). Otherwise the list of module
--   keys the client's users see in the navigation:
--     inbox, cases, contacts, pipelines, prospecting, agenda, ai,
--     broadcasts, channels, settings
--   Dashboard and notifications are always on.
--
-- This is navigation, not authorization: RLS still decides what data a
-- member can read. Hiding the AI pages from a client who didn't buy them
-- is product packaging, not a security boundary.

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS modules text[];

-- Only an operator linked to the account may change its modules.
CREATE OR REPLACE FUNCTION set_account_modules(p_account uuid, p_modules text[])
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM operator_accounts oa
    WHERE oa.user_id = auth.uid() AND oa.account_id = p_account
  ) THEN
    RAISE EXCEPTION 'not an operator of this account' USING ERRCODE = '42501';
  END IF;
  UPDATE accounts SET modules = p_modules, updated_at = now() WHERE id = p_account;
  INSERT INTO audit_log (account_id, actor_user_id, action, resource_type, resource_id, metadata)
  VALUES (p_account, auth.uid(), 'account.modules_changed', 'account', p_account,
          jsonb_build_object('modules', to_jsonb(p_modules)));
END;
$$;

REVOKE ALL ON FUNCTION set_account_modules(uuid, text[]) FROM public;
GRANT EXECUTE ON FUNCTION set_account_modules(uuid, text[]) TO authenticated;

-- The portfolio needs each client's modules; operators aren't members of
-- those accounts, so RLS on `accounts` would hide the row.
CREATE OR REPLACE FUNCTION operator_account_modules()
RETURNS TABLE (account_id uuid, modules text[])
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT a.id, a.modules
  FROM accounts a
  JOIN operator_accounts oa ON oa.account_id = a.id
  WHERE oa.user_id = auth.uid();
$$;

REVOKE ALL ON FUNCTION operator_account_modules() FROM public;
GRANT EXECUTE ON FUNCTION operator_account_modules() TO authenticated;
