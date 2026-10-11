-- ============================================================
-- 129: what each plan may use (specs/pricing-costs.md, section 10).
--
-- Until now the contracted plan (billing_subscriptions.plan) unlocked
-- nothing: an Essencial account could use everything Escala advertises.
-- This adds:
--
--   * accounts.plan — the plan the account is on, written by the billing
--     code (service role) when a subscription activates. NULL = no plan
--     limits (exempt accounts, the platform itself, legacy).
--   * plan_allows(account, feature) / plan_limit(account, feature) — the
--     SQL mirror of lib/billing/entitlements.ts. Keep the two in sync.
--   * BEFORE INSERT triggers on what the browser can create directly
--     under RLS (agents, routers, broadcasts, prospecting campaigns, API
--     keys, outbound webhooks, invitations), so a direct PostgREST call
--     cannot get around the API/UI checks — same reasoning as 106.
--   * A guard on the billing-controlled account columns. accounts_update
--     lets an admin PATCH their own row; without the guard a customer
--     could raise max_whatsapp_numbers, unlock modules or pick a plan.
--
-- Nothing existing is removed or disabled: limits only stop NEW rows.
-- ============================================================

ALTER TABLE public.accounts ADD COLUMN IF NOT EXISTS plan text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'accounts_plan_check') THEN
    ALTER TABLE public.accounts
      ADD CONSTRAINT accounts_plan_check
      CHECK (plan IS NULL OR plan IN ('essencial', 'profissional', 'escala'));
  END IF;
END $$;

-- Backfill from the live subscription, if any.
UPDATE public.accounts a
   SET plan = s.plan
  FROM public.billing_subscriptions s
 WHERE s.account_id = a.id
   AND s.status IN ('active', 'past_due')
   AND a.plan IS NULL
   AND s.plan IN ('essencial', 'profissional', 'escala');

-- Keep accounts.plan in step with the subscription: whatever activates or
-- changes it (billing_register_payment, checkout upsert, the sweep, the
-- Subscribers panel) goes through billing_subscriptions, so one trigger
-- there covers every path. A canceled subscription leaves the plan as is —
-- the account is locked by subscription_status anyway, and a reactivation
-- needs to know what it was.
CREATE OR REPLACE FUNCTION public.sync_account_plan()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status IN ('active', 'past_due')
     AND NEW.plan IN ('essencial', 'profissional', 'escala')
  THEN
    UPDATE public.accounts SET plan = NEW.plan
     WHERE id = NEW.account_id AND plan IS DISTINCT FROM NEW.plan;
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.sync_account_plan() OWNER TO postgres;

DROP TRIGGER IF EXISTS sync_account_plan ON public.billing_subscriptions;
CREATE TRIGGER sync_account_plan
  AFTER INSERT OR UPDATE OF plan, status ON public.billing_subscriptions
  FOR EACH ROW EXECUTE FUNCTION public.sync_account_plan();

-- ------------------------------------------------------------
-- Entitlements. NULL plan or exempt status = everything.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.plan_allows(p_account uuid, p_feature text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN a.plan IS NULL OR a.subscription_status = 'exempt' THEN true
    WHEN p_feature IN ('router', 'broadcasts', 'prospecting', 'followups')
      THEN a.plan IN ('profissional', 'escala')
    WHEN p_feature = 'api'
      THEN a.plan = 'escala'
    ELSE true
  END
  FROM public.accounts a
  WHERE a.id = p_account
$$;

-- NULL = unlimited.
CREATE OR REPLACE FUNCTION public.plan_limit(p_account uuid, p_feature text)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN a.plan IS NULL OR a.subscription_status = 'exempt' THEN NULL
    WHEN p_feature = 'agents' THEN
      CASE a.plan WHEN 'essencial' THEN 1 WHEN 'profissional' THEN 5 ELSE NULL END
    WHEN p_feature = 'users' THEN
      CASE a.plan WHEN 'essencial' THEN 3 WHEN 'profissional' THEN 8 ELSE 20 END
    ELSE NULL
  END
  FROM public.accounts a
  WHERE a.id = p_account
$$;

ALTER FUNCTION public.plan_allows(uuid, text) OWNER TO postgres;
ALTER FUNCTION public.plan_limit(uuid, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.plan_allows(uuid, text) FROM public;
REVOKE ALL ON FUNCTION public.plan_limit(uuid, text) FROM public;
GRANT EXECUTE ON FUNCTION public.plan_allows(uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.plan_limit(uuid, text) TO authenticated, service_role;

-- ------------------------------------------------------------
-- Feature switches: one trigger function, the feature is the argument.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_plan_feature()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.plan_allows(NEW.account_id, TG_ARGV[0]) THEN
    RAISE EXCEPTION 'plan_feature_unavailable:%', TG_ARGV[0]
      USING ERRCODE = 'insufficient_privilege',
            HINT = 'Upgrade the plan to use this feature.';
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.enforce_plan_feature() OWNER TO postgres;

DROP TRIGGER IF EXISTS enforce_plan_router ON public.ai_routers;
CREATE TRIGGER enforce_plan_router BEFORE INSERT ON public.ai_routers
  FOR EACH ROW EXECUTE FUNCTION public.enforce_plan_feature('router');

DROP TRIGGER IF EXISTS enforce_plan_broadcasts ON public.broadcasts;
CREATE TRIGGER enforce_plan_broadcasts BEFORE INSERT ON public.broadcasts
  FOR EACH ROW EXECUTE FUNCTION public.enforce_plan_feature('broadcasts');

DROP TRIGGER IF EXISTS enforce_plan_prospecting ON public.prospecting_campaigns;
CREATE TRIGGER enforce_plan_prospecting BEFORE INSERT ON public.prospecting_campaigns
  FOR EACH ROW EXECUTE FUNCTION public.enforce_plan_feature('prospecting');

DROP TRIGGER IF EXISTS enforce_plan_api_keys ON public.api_keys;
CREATE TRIGGER enforce_plan_api_keys BEFORE INSERT ON public.api_keys
  FOR EACH ROW EXECUTE FUNCTION public.enforce_plan_feature('api');

DROP TRIGGER IF EXISTS enforce_plan_webhooks ON public.webhook_endpoints;
CREATE TRIGGER enforce_plan_webhooks BEFORE INSERT ON public.webhook_endpoints
  FOR EACH ROW EXECUTE FUNCTION public.enforce_plan_feature('api');

-- ------------------------------------------------------------
-- Counted limits.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_plan_agents()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  lim integer := public.plan_limit(NEW.account_id, 'agents');
BEGIN
  IF lim IS NOT NULL
     AND (SELECT count(*) FROM public.ai_configs WHERE account_id = NEW.account_id) >= lim
  THEN
    RAISE EXCEPTION 'plan_limit_reached:agents'
      USING ERRCODE = 'insufficient_privilege',
            HINT = 'Upgrade the plan to add more AI agents.';
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.enforce_plan_agents() OWNER TO postgres;

DROP TRIGGER IF EXISTS enforce_plan_agents ON public.ai_configs;
CREATE TRIGGER enforce_plan_agents BEFORE INSERT ON public.ai_configs
  FOR EACH ROW EXECUTE FUNCTION public.enforce_plan_agents();

-- Members plus invitations still open count against the seat limit.
CREATE OR REPLACE FUNCTION public.enforce_plan_users()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  lim integer := public.plan_limit(NEW.account_id, 'users');
BEGIN
  IF lim IS NOT NULL AND (
       (SELECT count(*) FROM public.profiles WHERE account_id = NEW.account_id)
     + (SELECT count(*) FROM public.account_invitations
         WHERE account_id = NEW.account_id
           AND accepted_at IS NULL
           AND (expires_at IS NULL OR expires_at > now()))
     ) >= lim
  THEN
    RAISE EXCEPTION 'plan_limit_reached:users'
      USING ERRCODE = 'insufficient_privilege',
            HINT = 'Upgrade the plan to invite more users.';
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.enforce_plan_users() OWNER TO postgres;

DROP TRIGGER IF EXISTS enforce_plan_users ON public.account_invitations;
CREATE TRIGGER enforce_plan_users BEFORE INSERT ON public.account_invitations
  FOR EACH ROW EXECUTE FUNCTION public.enforce_plan_users();

-- ------------------------------------------------------------
-- Billing-controlled account columns: only the service role, the SQL
-- editor or a SECURITY DEFINER RPC (set_account_modules) may change them.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_account_billing_columns()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF current_user = 'authenticated' AND (
       NEW.plan IS DISTINCT FROM OLD.plan
    OR NEW.max_whatsapp_numbers IS DISTINCT FROM OLD.max_whatsapp_numbers
    OR NEW.modules IS DISTINCT FROM OLD.modules
    OR NEW.managed_by IS DISTINCT FROM OLD.managed_by
  ) THEN
    RAISE EXCEPTION 'billing-controlled account columns cannot be changed directly'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.enforce_account_billing_columns() OWNER TO postgres;

DROP TRIGGER IF EXISTS enforce_account_billing_columns ON public.accounts;
CREATE TRIGGER enforce_account_billing_columns
  BEFORE UPDATE ON public.accounts
  FOR EACH ROW EXECUTE FUNCTION public.enforce_account_billing_columns();

-- ============================================================
-- Manual validation:
--   1. SELECT name, plan, subscription_status FROM accounts;
--      -> the account with an active escala subscription has plan 'escala'.
--   2. With accounts.plan = 'essencial' (inside a rolled-back transaction):
--      inserting a 2nd ai_configs row fails with plan_limit_reached:agents,
--      inserting a broadcast fails with plan_feature_unavailable:broadcasts.
--   3. As an authenticated admin JWT,
--        PATCH /rest/v1/accounts?id=eq.<mine> { "max_whatsapp_numbers": 9 }
--      must return 42501; { "display_name": "x" } must still work.
-- ============================================================
