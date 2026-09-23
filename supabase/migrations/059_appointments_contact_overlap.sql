-- ============================================================
-- 059_appointments_contact_overlap.sql — block double-booking the
-- same contact across different calendars.
--
-- 058's appointments_no_overlap only excludes overlap WITHIN one
-- calendar (a specific agent's, or the shared one — partitioned by
-- assigned_to). It says nothing about the same contact ending up on
-- two different calendars at the same time — booking one appointment
-- assigned to an agent and a second on the shared calendar for the
-- same contact/time sailed through, because they're different
-- partitions of the first constraint.
--
-- This adds a second exclusion, partitioned by (account_id,
-- contact_id) instead of assigned_to — a contact can't have two
-- non-cancelled appointments whose time ranges overlap, full stop,
-- regardless of who each is assigned to.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'appointments_no_contact_overlap'
  ) THEN
    ALTER TABLE appointments
      ADD CONSTRAINT appointments_no_contact_overlap
      EXCLUDE USING gist (
        account_id WITH =,
        contact_id WITH =,
        tstzrange(starts_at, ends_at) WITH &&
      ) WHERE (status <> 'cancelled');
  END IF;
END $$;
