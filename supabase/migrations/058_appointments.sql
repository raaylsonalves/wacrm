-- ============================================================
-- 058_appointments.sql — customer appointments (specs/agenda-
-- appointments.md).
--
-- Two tables:
--   - appointment_settings: one row per account — business hours,
--     slot length, timezone and reminder config. Read by the slot
--     generator (dashboard + the offer_slots flow node) and the
--     reminder cron.
--   - appointments: a booking with a contact, optionally owned by an
--     agent. assigned_to NULL means the account's shared calendar.
--
-- Double booking is prevented in the database, not just the app: an
-- exclusion constraint rejects two non-cancelled appointments whose
-- time ranges overlap for the same agent (or both on the shared
-- calendar). That is what makes the bot safe when two customers tap
-- the same slot at the same moment — the second INSERT fails with
-- 23P01 and the flow re-offers slots instead of double-booking.
--
-- Also adds 'offer_slots' to flow_nodes.node_type.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA extensions;

CREATE TABLE IF NOT EXISTS appointment_settings (
  account_id uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  timezone text NOT NULL DEFAULT 'America/Sao_Paulo',
  -- 0 = Sunday … 6 = Saturday, matching JS Date#getDay().
  work_days int[] NOT NULL DEFAULT '{1,2,3,4,5}',
  day_start time NOT NULL DEFAULT '09:00',
  day_end time NOT NULL DEFAULT '18:00',
  slot_minutes int NOT NULL DEFAULT 30
    CHECK (slot_minutes BETWEEN 5 AND 480),
  reminder_enabled boolean NOT NULL DEFAULT true,
  reminder_hours_before int NOT NULL DEFAULT 24
    CHECK (reminder_hours_before BETWEEN 1 AND 168),
  reminder_text text NOT NULL DEFAULT
    'Olá {{nome}}! Lembrete do seu agendamento em {{data}} às {{hora}}. Até lá!',
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (day_end > day_start)
);

ALTER TABLE appointment_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS appointment_settings_select ON appointment_settings;
CREATE POLICY appointment_settings_select ON appointment_settings FOR SELECT
  USING (is_account_member(account_id));
DROP POLICY IF EXISTS appointment_settings_insert ON appointment_settings;
CREATE POLICY appointment_settings_insert ON appointment_settings FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS appointment_settings_update ON appointment_settings;
CREATE POLICY appointment_settings_update ON appointment_settings FOR UPDATE
  USING (is_account_member(account_id, 'admin'));

CREATE TABLE IF NOT EXISTS appointments (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  assigned_to uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  title text NOT NULL,
  notes text,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled', 'confirmed', 'completed', 'cancelled', 'no_show')),
  source text NOT NULL DEFAULT 'manual'
    CHECK (source IN ('manual', 'flow')),
  flow_run_id uuid REFERENCES flow_runs(id) ON DELETE SET NULL,
  reminder_sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);

CREATE INDEX IF NOT EXISTS idx_appointments_account_starts
  ON appointments (account_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_appointments_contact
  ON appointments (contact_id);
-- Reminder cron scans only upcoming, not-yet-reminded bookings.
CREATE INDEX IF NOT EXISTS idx_appointments_reminder_due
  ON appointments (starts_at)
  WHERE reminder_sent_at IS NULL AND status IN ('scheduled', 'confirmed');

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'appointments_no_overlap'
  ) THEN
    ALTER TABLE appointments
      ADD CONSTRAINT appointments_no_overlap
      EXCLUDE USING gist (
        account_id WITH =,
        (COALESCE(assigned_to, '00000000-0000-0000-0000-000000000000'::uuid)) WITH =,
        tstzrange(starts_at, ends_at) WITH &&
      ) WHERE (status <> 'cancelled');
  END IF;
END $$;

ALTER TABLE appointments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS appointments_select ON appointments;
CREATE POLICY appointments_select ON appointments FOR SELECT
  USING (is_account_member(account_id));
DROP POLICY IF EXISTS appointments_insert ON appointments;
CREATE POLICY appointments_insert ON appointments FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));
DROP POLICY IF EXISTS appointments_update ON appointments;
CREATE POLICY appointments_update ON appointments FOR UPDATE
  USING (is_account_member(account_id, 'agent'));
DROP POLICY IF EXISTS appointments_delete ON appointments;
CREATE POLICY appointments_delete ON appointments FOR DELETE
  USING (is_account_member(account_id, 'agent'));

-- The agenda page live-refreshes when the bot books a slot.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'appointments'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE appointments;
  END IF;
END $$;

ALTER TABLE flow_nodes
  DROP CONSTRAINT IF EXISTS flow_nodes_node_type_check;
ALTER TABLE flow_nodes
  ADD CONSTRAINT flow_nodes_node_type_check
  CHECK (node_type IN (
    'start',
    'send_buttons',
    'send_list',
    'send_message',
    'send_media',
    'collect_input',
    'condition',
    'set_tag',
    'handoff',
    'http_fetch',
    'offer_slots',
    'end'
  ));
