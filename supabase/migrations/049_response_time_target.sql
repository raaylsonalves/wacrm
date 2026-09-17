-- ============================================================
-- Accounts — configurable response-time SLA target
-- ============================================================
-- The dashboard's response-time chart showed a "target 5m" pill with
-- no setting anywhere to change it — `thresholdMinutes` was a
-- component prop nobody ever passed, silently pinned to the default.
-- Move it into account settings so it means something.

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS response_time_target_minutes INTEGER NOT NULL DEFAULT 5;

ALTER TABLE accounts
  ADD CONSTRAINT IF NOT EXISTS response_time_target_minutes_positive
  CHECK (response_time_target_minutes > 0);
