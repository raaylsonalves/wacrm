-- ============================================================
-- 061_appointments_ai_source.sql — widen appointments.source to
-- allow 'ai', for bookings made by the AI auto-reply agent's
-- book_appointment tool (specs/ai-agenda-tool-calling.md).
--
-- 058 only allowed 'manual' | 'flow'. Drop + recreate the check
-- rather than a bare ADD CONSTRAINT so re-running this file is a
-- no-op instead of a duplicate-constraint error.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE appointments DROP CONSTRAINT IF EXISTS appointments_source_check;

ALTER TABLE appointments
  ADD CONSTRAINT appointments_source_check CHECK (source IN ('manual', 'flow', 'ai'));
