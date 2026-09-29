-- ============================================================
-- 071_push_subscriptions.sql — Web Push device subscriptions
-- (specs/pwa-web-push-notifications.md).
--
-- One row per browser/device a user enabled push on. `endpoint` is
-- globally unique per browser+origin, so it alone is the upsert key.
--
-- Writes go through /api/notifications/push-subscription under the
-- service role, not straight from the browser: a shared device where
-- a second person signs in re-subscribes the SAME endpoint, and the
-- row must move to the new user — an RLS-scoped upsert can't take
-- over another user's row (nor should it be able to). Sending reads
-- under the service role too, from the inbound webhooks.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  endpoint text NOT NULL UNIQUE,
  p256dh text NOT NULL,
  auth_key text NOT NULL,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_account
  ON push_subscriptions (account_id);

ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;

-- Read / delete only your own devices. No INSERT/UPDATE policy: those
-- are service-role only (see header).
DROP POLICY IF EXISTS push_subscriptions_select_own ON push_subscriptions;
CREATE POLICY push_subscriptions_select_own ON push_subscriptions FOR SELECT
  USING (user_id = auth.uid());
DROP POLICY IF EXISTS push_subscriptions_delete_own ON push_subscriptions;
CREATE POLICY push_subscriptions_delete_own ON push_subscriptions FOR DELETE
  USING (user_id = auth.uid());
