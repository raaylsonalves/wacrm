-- ============================================================
-- 122: billing hardening (specs/review-2026-10.md, phase 1).
--
-- 1. billing_register_payment(): records one confirmed payment and applies
--    it to the subscription and the account in ONE transaction. Before,
--    the Pix order was flipped to `paid` (or the card charge claimed) and
--    only then the subscription updated; a failure in between made the
--    Mercado Pago redelivery look "already applied" and the payment was
--    never credited. The payment row (unique per provider reference) is
--    now the only idempotency marker, so a redelivery re-runs it safely.
--      * card: the period ends one month after the charge (the preapproval
--        may have seeded the end from next_payment_date already, and
--        extending THAT pushed it to two months);
--      * pix: a charge paid while the period still runs extends it;
--      * a cancelled subscription stays cancelled (a charge Mercado Pago
--        had already scheduled only extends the paid period).
--
-- 2. Pix orders are no longer overwritten in place. A replaced QR code's
--    row is kept (cancelled), so a late payment of it still matches a row
--    and is credited. Only one PENDING order per (account, period).
--
-- 3. billing_notifications: one row per billing notice sent, so a notice
--    (e-mail + WhatsApp) goes out once even when the cron overlaps or the
--    webhook is redelivered. Server-only (no RLS policies).
-- ============================================================

-- 2. Pix orders: keep replaced rows.
ALTER TABLE public.billing_pix_orders
  DROP CONSTRAINT IF EXISTS billing_pix_orders_account_id_period_start_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_pix_orders_one_pending
  ON public.billing_pix_orders (account_id, period_start)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_billing_pix_orders_account_period
  ON public.billing_pix_orders (account_id, period_start);

-- 3. Notices sent.
CREATE TABLE IF NOT EXISTS public.billing_notifications (
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, key)
);
ALTER TABLE public.billing_notifications ENABLE ROW LEVEL SECURITY;

-- 1. One confirmed payment, atomically.
CREATE OR REPLACE FUNCTION public.billing_register_payment(
  p_account_id uuid,
  p_method text,
  p_amount_cents integer,
  p_provider_ref text,
  p_paid_at timestamptz
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_payment uuid;
  s public.billing_subscriptions%ROWTYPE;
  v_charges integer;
  v_end timestamptz;
  v_done boolean;
  v_status text;
BEGIN
  INSERT INTO public.billing_payments
    (account_id, method, amount_cents, provider_ref, paid_at)
  VALUES (p_account_id, p_method, p_amount_cents, p_provider_ref, p_paid_at)
  ON CONFLICT (method, provider_ref) DO NOTHING
  RETURNING id INTO v_payment;
  IF v_payment IS NULL THEN
    RETURN jsonb_build_object('inserted', false);
  END IF;

  SELECT * INTO s FROM public.billing_subscriptions
   WHERE account_id = p_account_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('inserted', true, 'subscription', false);
  END IF;

  v_charges := s.charges_paid + 1;
  IF p_method = 'card' THEN
    v_end := p_paid_at + interval '1 month';
  ELSE
    v_end := greatest(coalesce(s.current_period_end, p_paid_at), p_paid_at)
             + interval '1 month';
  END IF;
  v_done := s.charges_total IS NOT NULL AND v_charges >= s.charges_total;
  v_status := CASE
    WHEN s.status = 'canceled' OR v_done THEN 'canceled'
    ELSE 'active'
  END;

  UPDATE public.billing_subscriptions
     SET charges_paid = v_charges,
         current_period_end = v_end,
         status = v_status,
         grace_until = NULL
   WHERE id = s.id;

  UPDATE public.accounts
     SET subscription_status = 'active'
   WHERE id = p_account_id
     AND subscription_status IS DISTINCT FROM 'exempt';

  RETURN jsonb_build_object(
    'inserted', true,
    'subscription', true,
    'period_end', v_end,
    'done', v_done,
    'status', v_status
  );
END;
$$;

REVOKE ALL ON FUNCTION public.billing_register_payment(uuid, text, integer, text, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.billing_register_payment(uuid, text, integer, text, timestamptz)
  TO service_role;
