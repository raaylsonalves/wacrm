-- ============================================================
-- 045_lock_account_owner_column.sql — lock down accounts.owner_user_id
--
-- The problem
--
--   accounts_update (migration 017) is `USING (is_account_member(id,
--   'admin')) WITH CHECK (is_account_member(id, 'admin'))` — row-level
--   only, same shape migration 034 already found and fixed on
--   `profiles`. Any admin (not just the owner) can therefore self-serve
--   ownership through the ordinary browser client:
--
--     PATCH /rest/v1/accounts?id=eq.<mine> { "owner_user_id": "<self>" }
--
--   The server-side PATCH /api/account route only whitelists `name`,
--   but that whitelist is not the only writer — the dashboard pages
--   query `accounts` directly as `authenticated`, so the API route's
--   restriction is bypassed entirely by going straight to PostgREST.
--   redeem_invitation's sole-owner check (019) and every place that
--   trusts `owner_user_id` to mean "the actual owner" (e.g. API-key
--   write attribution) would then be fooled by a self-appointed owner.
--
-- The fix
--
--   Same pattern as 034's enforce_profile_privilege_columns: a
--   BEFORE UPDATE trigger that rejects any change to `owner_user_id`
--   when the caller is the `authenticated` role. The only sanctioned
--   writer is transfer_account_ownership (019), which is SECURITY
--   DEFINER owned by postgres, so `current_user` there is `postgres`,
--   not `authenticated`.
-- ============================================================

CREATE OR REPLACE FUNCTION public.enforce_account_owner_column()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id
     AND current_user = 'authenticated'
  THEN
    RAISE EXCEPTION
      'owner_user_id cannot be changed directly; use transfer_account_ownership'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.enforce_account_owner_column() OWNER TO postgres;

DROP TRIGGER IF EXISTS enforce_account_owner_column ON public.accounts;
CREATE TRIGGER enforce_account_owner_column
  BEFORE UPDATE ON public.accounts
  FOR EACH ROW EXECUTE FUNCTION public.enforce_account_owner_column();

-- ============================================================
-- Manual validation (run against a live instance):
--
--   1. As a non-owner admin JWT via PostgREST, this must return
--      42501 (insufficient_privilege):
--        PATCH /rest/v1/accounts?id=eq.<mine> { "owner_user_id": "<self>" }
--   2. A self-service edit that leaves owner_user_id alone must still
--      succeed:
--        PATCH /rest/v1/accounts?id=eq.<mine> { "name": "New Name" }
--   3. transfer_account_ownership must still succeed — it runs
--      SECURITY DEFINER as postgres.
-- ============================================================
