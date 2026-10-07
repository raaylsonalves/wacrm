-- ============================================================
-- 109: one row per confirmed payment (Pix or card).
--
-- billing_subscriptions only counts charges (charges_paid) and
-- billing_pix_orders only covers Pix, so a card customer's payment history
-- did not exist anywhere. Written by the server when Mercado Pago confirms
-- a payment (lib/billing/apply.ts); read by the account's admins (Settings
-- > Billing) and by the platform's subscribers panel (service role).
-- Unique per provider reference, so a redelivered notification never
-- records the same payment twice.
-- ============================================================

CREATE TABLE IF NOT EXISTS billing_payments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  method TEXT NOT NULL CHECK (method IN ('pix', 'card')),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  -- Mercado Pago order id (Pix) or authorized payment id (card).
  provider_ref TEXT NOT NULL,
  paid_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (method, provider_ref)
);

CREATE INDEX IF NOT EXISTS idx_billing_payments_account
  ON billing_payments(account_id, paid_at DESC);

ALTER TABLE billing_payments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS billing_payments_select ON billing_payments;
CREATE POLICY billing_payments_select ON billing_payments FOR SELECT
  USING (is_account_member(account_id, 'admin'));
-- No write policy: only the service role records payments.

-- Pix payments confirmed before this table existed.
INSERT INTO billing_payments (account_id, method, amount_cents, provider_ref, paid_at)
SELECT account_id, 'pix', amount_cents, mp_order_id, COALESCE(paid_at, updated_at)
  FROM billing_pix_orders
 WHERE status = 'paid' AND mp_order_id IS NOT NULL
ON CONFLICT (method, provider_ref) DO NOTHING;
