-- ============================================================
-- 106: accounts.subscription_status — who may use paid-only features.
--
-- First piece of specs/mercadopago-checkout.md. For now it gates one
-- thing: creating team invitations. A new account is `pending` until a
-- payment is confirmed (or the platform operator releases it for a
-- trial by setting `exempt`); only `active` and `exempt` accounts can
-- invite teammates.
--
--   pending   created, nothing paid yet (default for new accounts)
--   active    paid
--   past_due  a charge failed
--   canceled  subscription ended
--   exempt    released by the operator (trial / own accounts)
--
-- Every account that exists when this runs becomes `exempt`: they
-- predate billing and must keep working. Adding the column WITH that
-- default backfills them, then the default flips to `pending` for
-- accounts created from now on.
--
-- Write access: the column can only be changed outside the
-- `authenticated` role (service role, SQL editor, the future payment
-- webhook). Without this, accounts_update (admins+) would let a
-- customer mark their own account `exempt`. Same discriminator as
-- 034/045: `current_user = 'authenticated'`.
-- ============================================================

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS subscription_status TEXT NOT NULL DEFAULT 'exempt';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'accounts_subscription_status_check'
  ) THEN
    ALTER TABLE accounts
      ADD CONSTRAINT accounts_subscription_status_check
      CHECK (subscription_status IN ('pending', 'active', 'past_due', 'canceled', 'exempt'));
  END IF;
END $$;

ALTER TABLE accounts ALTER COLUMN subscription_status SET DEFAULT 'pending';

CREATE OR REPLACE FUNCTION public.enforce_subscription_status_column()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.subscription_status IS DISTINCT FROM OLD.subscription_status
     AND current_user = 'authenticated'
  THEN
    RAISE EXCEPTION 'subscription_status cannot be changed directly'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.enforce_subscription_status_column() OWNER TO postgres;

DROP TRIGGER IF EXISTS enforce_subscription_status_column ON public.accounts;
CREATE TRIGGER enforce_subscription_status_column
  BEFORE UPDATE ON public.accounts
  FOR EACH ROW EXECUTE FUNCTION public.enforce_subscription_status_column();

-- Invitations: refuse to create one for an account that is not active or
-- exempt. A trigger (not just the API/UI check) so a direct PostgREST
-- insert under RLS cannot get around it.
CREATE OR REPLACE FUNCTION public.enforce_invitation_requires_active_account()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  status TEXT;
BEGIN
  SELECT subscription_status INTO status FROM accounts WHERE id = NEW.account_id;
  IF status IS NULL OR status NOT IN ('active', 'exempt') THEN
    RAISE EXCEPTION 'account_not_active'
      USING ERRCODE = 'insufficient_privilege',
            HINT = 'Invitations unlock once the subscription is active.';
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.enforce_invitation_requires_active_account() OWNER TO postgres;

DROP TRIGGER IF EXISTS enforce_invitation_requires_active_account ON public.account_invitations;
CREATE TRIGGER enforce_invitation_requires_active_account
  BEFORE INSERT ON public.account_invitations
  FOR EACH ROW EXECUTE FUNCTION public.enforce_invitation_requires_active_account();

-- ============================================================
-- Manual validation (against a live instance):
--   1. SELECT subscription_status, count(*) FROM accounts GROUP BY 1;
--      -> existing accounts are 'exempt'.
--   2. A new signup's account is 'pending'; creating an invitation for it
--      fails with account_not_active (42501).
--   3. As an authenticated admin JWT,
--        PATCH /rest/v1/accounts?id=eq.<mine> { "subscription_status": "exempt" }
--      must return 42501; { "name": "x" } must still work.
-- ============================================================
