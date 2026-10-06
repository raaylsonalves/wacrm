-- ============================================================
-- 107: billing tables for the Mercado Pago checkout
--      (specs/mercadopago-checkout.md).
--
--   billing_subscriptions  one row per account: plan, cycle, method and,
--                          for cards, the Mercado Pago preapproval id.
--   billing_pix_orders     one row per monthly Pix charge (Orders API).
--   billing_events         every webhook notification received, unique per
--                          (source, event id) so a retried delivery is
--                          recognised and ignored.
--
-- Write access: none for clients. There is no INSERT/UPDATE/DELETE policy,
-- so only the service role (checkout routes, webhook, cron) can change
-- these tables. Members read their own account's subscription and Pix
-- orders (the UI shows plan, renewal and the open QR code);
-- billing_events has no policy at all: raw payloads are server-only.
--
-- accounts.subscription_status (106) stays the single gate the app
-- checks; these tables are the facts behind it.
-- ============================================================

CREATE TABLE IF NOT EXISTS billing_subscriptions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'mercadopago',
  plan TEXT NOT NULL CHECK (plan IN ('essencial', 'profissional', 'escala')),
  cycle TEXT NOT NULL CHECK (cycle IN ('monthly', 'annual')),
  method TEXT NOT NULL CHECK (method IN ('pix', 'card')),
  -- Monthly charge in centavos, computed server-side from the plan table.
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  -- Cards only: Mercado Pago subscription (preapproval) and payer.
  mp_preapproval_id TEXT UNIQUE,
  mp_payer_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'active', 'past_due', 'canceled')),
  -- Annual = 12 monthly charges; stop asking for more after this many.
  charges_paid INTEGER NOT NULL DEFAULT 0 CHECK (charges_paid >= 0),
  charges_total INTEGER CHECK (charges_total IS NULL OR charges_total > 0),
  current_period_end TIMESTAMPTZ,
  grace_until TIMESTAMPTZ,
  canceled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS set_updated_at ON billing_subscriptions;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON billing_subscriptions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE billing_subscriptions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS billing_subscriptions_select ON billing_subscriptions;
CREATE POLICY billing_subscriptions_select ON billing_subscriptions FOR SELECT
  USING (is_account_member(account_id));

CREATE TABLE IF NOT EXISTS billing_pix_orders (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- Our own reference sent as external_reference; the webhook resolves the
  -- account from THIS row, never from anything the client supplied.
  external_reference TEXT NOT NULL UNIQUE,
  mp_order_id TEXT UNIQUE,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  -- The billing month this charge covers (first day of that month).
  period_start DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'paid', 'expired', 'canceled', 'failed')),
  -- Shown on our own payment screen while the order is open.
  qr_code TEXT,
  qr_code_base64 TEXT,
  ticket_url TEXT,
  expires_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- One charge per account per billing month.
  UNIQUE (account_id, period_start)
);

CREATE INDEX IF NOT EXISTS idx_billing_pix_orders_open
  ON billing_pix_orders(expires_at) WHERE status = 'pending';

DROP TRIGGER IF EXISTS set_updated_at ON billing_pix_orders;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON billing_pix_orders
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE billing_pix_orders ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS billing_pix_orders_select ON billing_pix_orders;
CREATE POLICY billing_pix_orders_select ON billing_pix_orders FOR SELECT
  USING (is_account_member(account_id, 'admin'));

CREATE TABLE IF NOT EXISTS billing_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  -- Which Mercado Pago application signed the notification.
  source TEXT NOT NULL CHECK (source IN ('subs', 'pix')),
  event_id TEXT NOT NULL,
  topic TEXT,
  raw JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ,
  UNIQUE (source, event_id)
);

ALTER TABLE billing_events ENABLE ROW LEVEL SECURITY;
-- Deliberately no policies: server-only.

-- ============================================================
-- Manual validation (against a live instance):
--   1. As an authenticated member JWT, SELECT on billing_subscriptions
--      returns only their account's row; INSERT/UPDATE/DELETE on any of
--      the three tables fails (no policy).
--   2. billing_events returns nothing to authenticated.
--   3. Inserting the same (source, event_id) twice fails with 23505.
-- ============================================================
