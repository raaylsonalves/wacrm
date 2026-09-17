-- ============================================================
-- 046_automation_pending_claimed_at.sql — reclaim stuck 'running' rows
--
-- The problem
--
--   The cron's claim step (GET /api/automations/cron) flips a due row
--   from 'pending' to 'running' as a lock, then calls
--   resumePendingExecution, which sets 'done' or 'failed' in its own
--   try/catch. If the process dies in between — a serverless timeout
--   (this route sets no maxDuration) or a pod recycle — the row is
--   stuck at 'running' forever. Nothing ever re-reads a 'running' row
--   (only 'pending' is queried), so a parked "wait 2 days, then follow
--   up" step that loses its resuming invocation never fires again, with
--   no error surfaced anywhere.
--
-- The fix
--
--   Add `claimed_at`, stamped when a row is claimed. The cron now also
--   reclaims rows stuck in 'running' past a staleness window (10
--   minutes — comfortably longer than any single automation step
--   should take), the same way it claims 'pending' ones.
-- ============================================================

ALTER TABLE automation_pending_executions
  ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;

COMMENT ON COLUMN automation_pending_executions.claimed_at IS
  'Set when the cron flips a row to running. A row still running well past a normal step''s duration is reclaimed by the cron rather than left stuck forever.';
