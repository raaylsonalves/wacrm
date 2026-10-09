-- ============================================================
-- 120: periodic health check of official (Meta) numbers.
--
-- A number's `status` only changes when someone saves it, so a token that
-- expires on its own (Meta's 24-hour test tokens, a revoked system user)
-- went unnoticed until a send failed. The cron now asks Meta about each
-- number every 30 minutes (lib/whatsapp/official-health.ts) and records
-- the failure here; the inbox banner and the numbers list read it, and the
-- account's admins are notified once when a number starts failing.
-- `status` is left alone: it still describes the registration flow.
-- ============================================================

ALTER TABLE public.whatsapp_config
  ADD COLUMN IF NOT EXISTS health_error text,
  ADD COLUMN IF NOT EXISTS health_checked_at timestamptz;
