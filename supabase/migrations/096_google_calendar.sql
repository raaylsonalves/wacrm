-- 096_google_calendar.sql
--
-- Google Calendar sync, phase A (specs/google-calendar-sync.md):
--   * push — every booking made in wacrm (dashboard, AI, flow) appears in
--     the owner's Google Calendar, and moves/cancellations follow;
--   * pull — events the owner puts in Google block those hours for the
--     dashboard picker, the offer_slots node and the AI tools.
-- Edits made in Google to our own events (phase B) are not applied back.
--
-- Differences from the spec draft, on purpose:
--   * no sync_token: the pull re-reads a bounded window (yesterday → +60d)
--     and replaces that connection's blocks. Deletions need no special
--     case and there is no 410/resync path to get wrong.
--   * appointment_google_events has no FK to appointments: a deleted
--     appointment must still find its Google event to delete it. The
--     event id is derived from the appointment id anyway.

CREATE TABLE IF NOT EXISTS calendar_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- NULL = the account's shared calendar; else that member's own.
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  provider text NOT NULL DEFAULT 'google' CHECK (provider IN ('google')),
  google_email text NOT NULL,
  google_calendar_id text NOT NULL DEFAULT 'primary',
  refresh_token_enc text NOT NULL,      -- AES-256-GCM, never selectable by clients
  scopes text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'needs_reauth', 'disabled')),
  last_synced_at timestamptz,
  last_error text,
  include_customer_phone boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_calendar_conn_shared
  ON calendar_connections (account_id) WHERE user_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_calendar_conn_member
  ON calendar_connections (account_id, user_id) WHERE user_id IS NOT NULL;

ALTER TABLE calendar_connections ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS calendar_connections_select ON calendar_connections;
CREATE POLICY calendar_connections_select ON calendar_connections FOR SELECT
  USING (is_account_member(account_id, 'viewer'));
-- The token column never reaches a browser: column privileges exclude it.
REVOKE SELECT ON calendar_connections FROM authenticated, anon;
GRANT SELECT (id, account_id, user_id, provider, google_email, google_calendar_id,
              status, last_synced_at, last_error, include_customer_phone, created_at)
  ON calendar_connections TO authenticated;

CREATE TABLE IF NOT EXISTS appointment_google_events (
  appointment_id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES calendar_connections(id) ON DELETE CASCADE,
  google_event_id text NOT NULL,
  synced_at timestamptz,
  last_error text
);
ALTER TABLE appointment_google_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS appointment_google_events_select ON appointment_google_events;
CREATE POLICY appointment_google_events_select ON appointment_google_events FOR SELECT
  USING (is_account_member(account_id, 'viewer'));

-- Events that exist only in Google (lunch, day off): they block slots but
-- never become appointments (they'd trip the exclusion constraint).
CREATE TABLE IF NOT EXISTS calendar_busy_blocks (
  connection_id uuid NOT NULL REFERENCES calendar_connections(id) ON DELETE CASCADE,
  google_event_id text NOT NULL,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  all_day boolean NOT NULL DEFAULT false,
  PRIMARY KEY (connection_id, google_event_id, starts_at)
);
CREATE INDEX IF NOT EXISTS idx_busy_blocks_range
  ON calendar_busy_blocks (account_id, starts_at, ends_at);
ALTER TABLE calendar_busy_blocks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS calendar_busy_blocks_select ON calendar_busy_blocks;
CREATE POLICY calendar_busy_blocks_select ON calendar_busy_blocks FOR SELECT
  USING (is_account_member(account_id, 'viewer'));

-- Outbox: written by the trigger below, drained by the cron worker. This
-- is what makes bookings written from the browser visible to the sync.
-- One pending row per appointment (coalesced).
CREATE TABLE IF NOT EXISTS calendar_sync_outbox (
  id bigserial PRIMARY KEY,
  account_id uuid NOT NULL,
  appointment_id uuid NOT NULL,
  op text NOT NULL CHECK (op IN ('upsert', 'delete')),
  attempts smallint NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_calendar_outbox_appointment
  ON calendar_sync_outbox (appointment_id);
CREATE INDEX IF NOT EXISTS idx_calendar_outbox_due
  ON calendar_sync_outbox (next_attempt_at);
ALTER TABLE calendar_sync_outbox ENABLE ROW LEVEL SECURITY;
-- no policies: service role only

CREATE OR REPLACE FUNCTION enqueue_calendar_sync()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row appointments%ROWTYPE;
  v_op text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_row := OLD;
    v_op := 'delete';
  ELSE
    v_row := NEW;
    v_op := CASE WHEN NEW.status = 'cancelled' THEN 'delete' ELSE 'upsert' END;
    -- Reminder bookkeeping and no-op saves don't touch the calendar.
    IF TG_OP = 'UPDATE'
       AND NEW.starts_at = OLD.starts_at AND NEW.ends_at = OLD.ends_at
       AND NEW.title = OLD.title AND NEW.notes IS NOT DISTINCT FROM OLD.notes
       AND NEW.status = OLD.status
       AND NEW.assigned_to IS NOT DISTINCT FROM OLD.assigned_to THEN
      RETURN NULL;
    END IF;
  END IF;

  -- Nothing to do for an account that never connected a calendar.
  IF NOT EXISTS (SELECT 1 FROM calendar_connections c
                  WHERE c.account_id = v_row.account_id AND c.status <> 'disabled') THEN
    RETURN NULL;
  END IF;

  INSERT INTO calendar_sync_outbox (account_id, appointment_id, op)
  VALUES (v_row.account_id, v_row.id, v_op)
  ON CONFLICT (appointment_id) DO UPDATE
    SET op = EXCLUDED.op, attempts = 0, next_attempt_at = now(), last_error = NULL;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_appointments_calendar_sync ON appointments;
CREATE TRIGGER trg_appointments_calendar_sync
  AFTER INSERT OR UPDATE OR DELETE ON appointments
  FOR EACH ROW EXECUTE FUNCTION enqueue_calendar_sync();
