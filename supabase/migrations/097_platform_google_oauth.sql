-- 097_platform_google_oauth.sql
--
-- The Google OAuth app of THIS installation, set from the screen instead of
-- the server's env (same idea as deskcomm's /admin/google). The credential
-- belongs to the installation, not to an account: every account's "Connect
-- Google Calendar" uses it, so only the agency owner (migration 092's
-- agency_home_if_owner) may change it — a client admin swapping it would
-- break everyone's connection.
--
-- Env vars GOOGLE_OAUTH_CLIENT_ID/SECRET still win when set.
-- RLS on, zero policies: only the service role reads or writes it.

CREATE TABLE IF NOT EXISTS platform_google_oauth (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),   -- single row
  client_id text NOT NULL,
  client_secret_enc text NOT NULL,                  -- AES-256-GCM under ENCRYPTION_KEY
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE platform_google_oauth ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON platform_google_oauth FROM anon, authenticated;
