-- ============================================================
-- Accounts — configurable response-time SLA target
-- ============================================================
-- The dashboard's response-time chart showed a "target 5m" pill with
-- no setting anywhere to change it — `thresholdMinutes` was a
-- component prop nobody ever passed, silently pinned to the default.
-- Move it into account settings so it means something.

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS response_time_target_minutes INTEGER NOT NULL DEFAULT 5;

-- Postgres has no `ADD CONSTRAINT IF NOT EXISTS` — guard manually so a
-- replay against an already-migrated database is a no-op, not an error.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'response_time_target_minutes_positive'
      AND conrelid = 'public.accounts'::regclass
  ) THEN
    ALTER TABLE accounts
      ADD CONSTRAINT response_time_target_minutes_positive
      CHECK (response_time_target_minutes > 0);
  END IF;
END $$;
