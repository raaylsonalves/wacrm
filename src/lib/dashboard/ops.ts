/**
 * Pure shaping for the dashboard's operations blocks (migration 089 does
 * the counting): the weekday × hour heatmap and the AI / team split.
 */

export interface HeatCell {
  dow: number; // 0 = Sunday, as Postgres extract(dow)
  hour: number;
  n: number;
}

/** Rows Monday-first (like the rest of the dashboard), 24 hours each. */
export const HEAT_ROWS = [1, 2, 3, 4, 5, 6, 0];

export function heatmapMatrix(cells: HeatCell[]): {
  grid: number[][];
  max: number;
  peak: { dow: number; hour: number; n: number } | null;
} {
  const grid = HEAT_ROWS.map(() => Array.from({ length: 24 }, () => 0));
  let peak: { dow: number; hour: number; n: number } | null = null;
  for (const c of cells) {
    const row = HEAT_ROWS.indexOf(c.dow);
    if (row < 0 || c.hour < 0 || c.hour > 23) continue;
    const n = Number(c.n) || 0;
    grid[row][c.hour] += n;
    if (!peak || grid[row][c.hour] > peak.n)
      peak = { dow: c.dow, hour: c.hour, n: grid[row][c.hour] };
  }
  const max = Math.max(0, ...grid.flat());
  return { grid, max, peak: max > 0 ? peak : null };
}

/** 0–4 intensity bucket for a cell, so the colour scale stays readable. */
export function heatLevel(n: number, max: number): number {
  if (n <= 0 || max <= 0) return 0;
  return Math.min(4, Math.ceil((n / max) * 4));
}

/** Share of replies the AI sent, 0–100, or null with no replies at all. */
export function aiShare(aiReplies: number, teamReplies: number): number | null {
  const total = aiReplies + teamReplies;
  return total > 0 ? Math.round((aiReplies / total) * 100) : null;
}
