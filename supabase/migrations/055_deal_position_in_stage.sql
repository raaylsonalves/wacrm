-- ============================================================
-- 055_deal_position_in_stage.sql — manual card ordering within a
-- pipeline stage.
--
-- Until now `deals` had no ordering column of its own; the board
-- displayed `ORDER BY created_at DESC` and dragging a card only ever
-- changed its `stage_id` — there was no way to reorder cards within
-- the same column, and any attempt to would have nothing to persist
-- it against.
--
-- `position_in_stage` is NUMERIC (not INTEGER) so the board can drop
-- a card between two neighbors by writing the midpoint of their two
-- positions (`lib/pipelines/reorder.ts` → `midpoint()`) instead of
-- renumbering every card in the column on every drag.
--
-- A BEFORE INSERT/UPDATE trigger fills in "append to the end of this
-- stage" whenever a write doesn't specify a position explicitly, so
-- every existing insert path (the deal form, the automations engine's
-- create_deal step) gets a sane default for free — none of them need
-- to change. The board's own drag handler computes and sends an
-- explicit position, which the trigger then leaves alone.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS position_in_stage NUMERIC;

-- Backfill: give every existing deal a position matching its current
-- on-screen order (newest first, the pre-migration sort) so the first
-- load after this migration doesn't visibly reshuffle anyone's board.
-- Re-runnable: only touches rows that are still NULL.
WITH ranked AS (
  SELECT id,
         1024 * ROW_NUMBER() OVER (
           PARTITION BY stage_id ORDER BY created_at DESC
         ) AS pos
  FROM deals
  WHERE position_in_stage IS NULL
)
UPDATE deals
SET position_in_stage = ranked.pos
FROM ranked
WHERE deals.id = ranked.id;

CREATE INDEX IF NOT EXISTS idx_deals_stage_position
  ON deals (stage_id, position_in_stage);

CREATE OR REPLACE FUNCTION public.fn_deal_default_position_in_stage()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.position_in_stage IS NULL THEN
    SELECT COALESCE(MAX(position_in_stage), 0) + 1024
      INTO NEW.position_in_stage
      FROM deals
      WHERE stage_id = NEW.stage_id;
  ELSIF TG_OP = 'UPDATE'
    AND NEW.stage_id IS DISTINCT FROM OLD.stage_id
    AND NEW.position_in_stage IS NOT DISTINCT FROM OLD.position_in_stage
  THEN
    -- Stage changed but the caller didn't say where in the new
    -- column the card should land (e.g. reassigning via the deal
    -- form's stage dropdown, not a board drag) — append to the end.
    SELECT COALESCE(MAX(position_in_stage), 0) + 1024
      INTO NEW.position_in_stage
      FROM deals
      WHERE stage_id = NEW.stage_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_deal_default_position_in_stage ON deals;
CREATE TRIGGER trg_deal_default_position_in_stage
  BEFORE INSERT OR UPDATE ON deals
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_deal_default_position_in_stage();
