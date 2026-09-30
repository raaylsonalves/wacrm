/**
 * Pure pieces of the "Today" screen: which greeting, where "today" and
 * "yesterday" start in the viewer's local time, and the day-over-day
 * change shown under each number.
 */

export type Greeting = 'morning' | 'afternoon' | 'evening';

export function greetingFor(hour: number): Greeting {
  if (hour >= 5 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 18) return 'afternoon';
  return 'evening';
}

/** Local midnight today and yesterday, as Dates. */
export function dayBounds(now: Date): {
  todayStart: Date;
  yesterdayStart: Date;
} {
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterdayStart = new Date(todayStart);
  yesterdayStart.setDate(yesterdayStart.getDate() - 1);
  return { todayStart, yesterdayStart };
}

/**
 * Percent change from yesterday to today, rounded. null when yesterday was
 * zero (a "+∞%" says nothing) — the screen then shows no comparison.
 */
export function pctChange(today: number, yesterday: number): number | null {
  if (yesterday <= 0) return null;
  return Math.round(((today - yesterday) / yesterday) * 100);
}

/** First word of a full name, for the greeting. */
export function firstName(full: string | null | undefined): string {
  return (full ?? '').trim().split(/\s+/)[0] ?? '';
}
