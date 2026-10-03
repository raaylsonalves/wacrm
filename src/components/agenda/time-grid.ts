/**
 * Pure layout for the agenda's hour grid (v2 week view): which hours the
 * grid spans and where each appointment sits, side by side when they
 * overlap. Minutes are minutes since local midnight.
 */

/** Height of one hour row, in px. */
export const HOUR_PX = 54;
/** Short appointments still need room for a name. */
const MIN_HEIGHT_PX = 24;
/** Breathing room between back-to-back blocks. */
const GAP_PX = 4;

export interface GridItem {
  id: string;
  startMin: number;
  endMin: number;
}

export interface PlacedItem {
  id: string;
  top: number;
  height: number;
  /** 0-based column inside its overlap group… */
  lane: number;
  /** …out of this many. */
  lanes: number;
}

/**
 * Whole hours covering the business day and every item, so an
 * appointment booked outside hours is never cut off.
 */
export function gridRange(
  dayStartMin: number,
  dayEndMin: number,
  items: GridItem[]
): { from: number; to: number } {
  let from = dayStartMin;
  let to = Math.max(dayEndMin, dayStartMin + 60);
  for (const it of items) {
    from = Math.min(from, it.startMin);
    to = Math.max(to, it.endMin);
  }
  return {
    from: Math.floor(from / 60) * 60,
    to: Math.min(24 * 60, Math.ceil(to / 60) * 60),
  };
}

/** Top/height in px plus overlap lanes, for one day's items. */
export function placeItems(items: GridItem[], from: number): PlacedItem[] {
  const sorted = [...items].sort(
    (a, b) => a.startMin - b.startMin || b.endMin - a.endMin
  );
  const out: PlacedItem[] = [];
  let group: { item: GridItem; lane: number }[] = [];
  let groupEnd = -Infinity;

  const flush = () => {
    const lanes = group.reduce((n, g) => Math.max(n, g.lane + 1), 1);
    for (const { item, lane } of group) {
      const top = ((item.startMin - from) / 60) * HOUR_PX;
      const height = Math.max(
        MIN_HEIGHT_PX,
        ((Math.max(item.endMin, item.startMin + 1) - item.startMin) / 60) *
          HOUR_PX -
          GAP_PX
      );
      out.push({ id: item.id, top, height, lane, lanes });
    }
    group = [];
  };

  for (const item of sorted) {
    if (item.startMin >= groupEnd && group.length) flush();
    // First lane whose last item has already ended.
    const laneEnds: number[] = [];
    for (const g of group)
      laneEnds[g.lane] = Math.max(laneEnds[g.lane] ?? -Infinity, g.item.endMin);
    let lane = laneEnds.findIndex((end) => end <= item.startMin);
    if (lane === -1) lane = laneEnds.length;
    group.push({ item, lane });
    groupEnd = Math.max(groupEnd, item.endMin);
  }
  if (group.length) flush();
  return out;
}

/** Minute of the day under a click at `y` px, snapped down to `step`. */
export function minuteAt(y: number, from: number, step: number): number {
  const raw = from + (Math.max(0, y) / HOUR_PX) * 60;
  return Math.floor(raw / step) * step;
}
