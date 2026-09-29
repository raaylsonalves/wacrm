-- ============================================================
-- 083_prospecting_followups.sql — nudging leads who didn't reply
-- (specs/prospecting-csv-import.md, part B).
--
--   followups_sent — touches sent after the first message.
--   last_touch_at  — when the lead was last written to (first message or
--                    follow-up); drives both the follow-up spacing and the
--                    daily cap, which counts first touches and follow-ups
--                    together.
--
-- Additive and idempotent.
-- ============================================================
ALTER TABLE prospecting_candidates
  ADD COLUMN IF NOT EXISTS followups_sent integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_touch_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_prospecting_candidates_followup
  ON prospecting_candidates (campaign_id, status, last_touch_at)
  WHERE replied_at IS NULL AND opted_out_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_prospecting_candidates_touch
  ON prospecting_candidates (account_id, last_touch_at);
