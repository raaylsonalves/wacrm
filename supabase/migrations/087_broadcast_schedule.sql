-- ============================================================
-- Scheduled broadcasts (specs/scheduled-broadcasts.md)
-- ============================================================
-- `scheduled_at` and the 'scheduled' status have existed since 001 but
-- nothing wrote or read them. The wizard now schedules and the cron
-- (/api/automations/cron) sends when due. A scheduled broadcast can be
-- cancelled before it starts, which needs its own terminal status —
-- 'draft' would read as "never finished", not "stopped on purpose".

ALTER TABLE broadcasts DROP CONSTRAINT IF EXISTS broadcasts_status_check;
ALTER TABLE broadcasts
  ADD CONSTRAINT broadcasts_status_check
  CHECK (status IN ('draft', 'scheduled', 'sending', 'sent', 'failed', 'cancelled'));

-- The cron's scan: due scheduled broadcasts.
CREATE INDEX IF NOT EXISTS idx_broadcasts_scheduled_due
  ON broadcasts (scheduled_at)
  WHERE status = 'scheduled';
