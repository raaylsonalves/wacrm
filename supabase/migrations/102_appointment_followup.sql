-- 102_appointment_followup.sql
--
-- A message N days after an appointment ("como ficou o corte?", "bora
-- marcar o próximo?"). By then Meta's 24h window is almost always
-- closed, so unlike the reminder it is an approved template, not free
-- text. The appointments cron sends it once per booking:
-- followup_sent_at is the claim, set before the send.

ALTER TABLE appointment_settings
  ADD COLUMN IF NOT EXISTS followup_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE appointment_settings
  ADD COLUMN IF NOT EXISTS followup_days_after int NOT NULL DEFAULT 1;
ALTER TABLE appointment_settings
  ADD COLUMN IF NOT EXISTS followup_template_id uuid
    REFERENCES message_templates(id) ON DELETE SET NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'appointment_settings_followup_days_check'
  ) THEN
    ALTER TABLE appointment_settings
      ADD CONSTRAINT appointment_settings_followup_days_check
      CHECK (followup_days_after BETWEEN 1 AND 90);
  END IF;
END $$;

ALTER TABLE appointments ADD COLUMN IF NOT EXISTS followup_sent_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_appointments_followup_due
  ON appointments (starts_at)
  WHERE followup_sent_at IS NULL AND status IN ('scheduled', 'confirmed', 'completed');
