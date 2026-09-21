/**
 * Fractional-indexing helpers for `deals.position_in_stage` (migration
 * 055). Dropping a card between two neighbors writes ONE row — the
 * midpoint of their positions — instead of renumbering every card in
 * the column on every drag.
 *
 * `1024` (`DEFAULT_GAP`) matches the spacing the migration's backfill
 * and the DB trigger both use for "append to the end", so a freshly
 * inserted card and a dragged-to-the-end card land the same distance
 * apart as everything else.
 */

const DEFAULT_GAP = 1024;

/**
 * Position for a card dropped between `prev` and `next` (either may be
 * `null` for "dropped at the very top/bottom of the column").
 *
 * - Both `null` (empty column): starts at `DEFAULT_GAP` rather than 0,
 *   so a card inserted above it later still has room.
 * - `prev` only (dropped at the end): `prev + DEFAULT_GAP`.
 * - `next` only (dropped at the start): `next / 2` if next allows a
 *   whole gap below it, else `next - DEFAULT_GAP` (goes negative,
 *   which is fine — NUMERIC has no floor, and ordering is all that
 *   matters).
 * - Both present: the exact midpoint.
 */
export function midpoint(prev: number | null, next: number | null): number {
  if (prev === null && next === null) return DEFAULT_GAP;
  if (prev === null) return (next as number) - DEFAULT_GAP;
  if (next === null) return prev + DEFAULT_GAP;
  return (prev + next) / 2;
}

/** Minimal shape `computeDropPosition` needs from a deal. */
export interface PositionedItem {
  id: string;
  position_in_stage: number | null;
}

/**
 * Position for `draggedId` inserted at `targetIndex` within
 * `siblings` — the OTHER cards already in the destination stage, in
 * display order, with the dragged card removed if it started there
 * (callers pass the pre-drag list of "everyone else in that column").
 */
export function computeDropPosition(
  siblings: PositionedItem[],
  targetIndex: number
): number {
  const clampedIndex = Math.max(0, Math.min(targetIndex, siblings.length));
  const prev =
    clampedIndex > 0 ? siblings[clampedIndex - 1].position_in_stage : null;
  const next =
    clampedIndex < siblings.length
      ? siblings[clampedIndex].position_in_stage
      : null;
  return midpoint(prev, next);
}
