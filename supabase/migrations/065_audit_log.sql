-- ============================================================
-- 065_audit_log.sql — structured, tamper-resistant audit log
-- (specs/audit-log-endurecido.md).
--
-- Scoped to the first high-risk mutation points only (WAHA channel
-- connect/disconnect, member role change, broadcast dispatch, contact
-- anonymization) — expand the call sites later once the pattern is
-- validated, not the table shape.
--
-- The REVOKE below is the whole point of this table over a plain
-- insert-only log: Supabase's default ACL on a new `public` table
-- grants INSERT/UPDATE/DELETE to `anon`, `authenticated`, AND
-- `service_role` — a GRANT only ever adds, so without an explicit
-- REVOKE a leaked service-role key (the same key every server route
-- in this app already holds) could erase its own trail. Revoking
-- UPDATE/DELETE/TRUNCATE from all three means even that key can only
-- ever append.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- Null for system/cron-triggered events (none yet at this scope, but
  -- the shape should not need a migration the day one shows up).
  actor_user_id uuid REFERENCES auth.users(id),
  -- e.g. 'channel.created', 'channel.deleted', 'member.role_changed',
  -- 'broadcast.sent', 'contact.anonymized'. Free-form text, not an
  -- enum — new actions shouldn't need a migration to start logging.
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id uuid,
  -- Describes the mutation only — NEVER a token, secret, or message
  -- body. e.g. { "old_role": "agent", "new_role": "admin" }.
  metadata jsonb NOT NULL DEFAULT '{}',
  request_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_account_created
  ON audit_log (account_id, created_at DESC);

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;

-- Read: any member of the account (mirrors every other account-scoped
-- table's SELECT policy) — an agent should be able to see "who did
-- what" for their own account, not just admins.
DROP POLICY IF EXISTS audit_log_select ON audit_log;
CREATE POLICY audit_log_select ON audit_log FOR SELECT
  USING (is_account_member(account_id));

-- Write: service-role only (the audit() helper always runs under
-- supabaseAdmin() — the mutation routes it's called from are already
-- gated by requireRole, and RLS on this table isn't where that
-- decision belongs). No INSERT policy for `authenticated`/`anon` at
-- all — writing a fabricated audit row is exactly the thing this
-- table exists to prevent.
DROP POLICY IF EXISTS audit_log_insert ON audit_log;
CREATE POLICY audit_log_insert ON audit_log FOR INSERT
  TO service_role
  WITH CHECK (true);

-- The hardening: no role — not even service_role — can UPDATE,
-- DELETE, or TRUNCATE this table via PostgREST. Only the database
-- owner (never used by the app) can. REVOKE after GRANT because
-- Supabase's default ACL already granted these to all three roles at
-- CREATE TABLE time; an enumerated GRANT elsewhere would silently
-- re-add what this REVOKE just removed, so nothing downstream should
-- ever GRANT UPDATE/DELETE/TRUNCATE on this table again.
REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM anon, authenticated, service_role;
GRANT SELECT ON audit_log TO authenticated;
GRANT INSERT ON audit_log TO service_role;
