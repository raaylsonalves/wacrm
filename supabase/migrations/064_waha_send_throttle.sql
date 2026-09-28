-- ============================================================
-- 064_waha_send_throttle.sql — anti-ban send throttle for WAHA
-- channels (specs/waha-anti-banimento-e-opt-out.md).
--
-- An in-memory counter (the pattern `src/lib/rate-limit.ts` already
-- uses, with its own trade-off documented right there) can't
-- coordinate this: the app runs serverless (Vercel), so two
-- concurrent invocations sending on the same WAHA session — an agent
-- reply and an automation firing at the same moment, say — would
-- each hold their own counter and both slip through. The claim below
-- is an atomic UPDATE...WHERE...RETURNING, same shape as
-- claim_ai_reply_slot (migration 029/031): the second of two
-- concurrent callers simply doesn't see the row match once the first
-- has already committed its `last_sent_at`, so only one claim can
-- ever win a given interval.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE whatsapp_waha_channels
  ADD COLUMN IF NOT EXISTS last_sent_at timestamptz;

CREATE OR REPLACE FUNCTION public.claim_waha_send_slot(
  channel_id uuid,
  min_interval_ms integer
)
RETURNS boolean AS $$
  WITH claimed AS (
    UPDATE whatsapp_waha_channels
    SET last_sent_at = now()
    WHERE id = channel_id
      AND (last_sent_at IS NULL
           OR last_sent_at <= now() - (min_interval_ms::text || ' ms')::interval)
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM claimed);
$$ LANGUAGE sql SECURITY DEFINER SET search_path = public;

-- Called from the outbound send path under the service-role client
-- (send-message.ts's `supabaseAdmin()`, same as claim_ai_reply_slot's
-- caller) — no auth.uid() there, so PUBLIC's default EXECUTE isn't
-- enough on a hardened/self-hosted Supabase where it's been revoked.
GRANT EXECUTE ON FUNCTION public.claim_waha_send_slot(uuid, integer) TO service_role;
