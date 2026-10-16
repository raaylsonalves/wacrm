/**
 * Goals and the per-person day (migration 136, specs/painel-gestor.md
 * phase 4). Pure helpers so the panels stay thin.
 */
export const GOAL_METRICS = [
  'won_value',
  'deals_won',
  'appointments',
  'conversations',
] as const;
export type GoalMetric = (typeof GOAL_METRICS)[number];
export type GoalPeriod = 'day' | 'month';

export interface GoalRow {
  id?: string;
  user_id: string | null;
  metric: GoalMetric;
  period: GoalPeriod;
  target: number | string;
}

export interface PerfLike {
  conversations: number | string;
  deals_won: number | string;
  won_value: number | string;
  appointments: number | string;
}

export function metricValue(
  row: PerfLike | undefined,
  metric: GoalMetric
): number {
  return row ? Number(row[metric]) || 0 : 0;
}

/** 0–100+ (can pass 100), or null without a target. */
export function progressPct(
  actual: number,
  target: number | null | undefined
): number | null {
  if (!target || target <= 0) return null;
  return Math.round((actual / target) * 100);
}

/** Expected share of a month's goal by now (day of month / days). */
export function monthPace(now: Date): number {
  const days = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  return Math.round(((now.getDate() - 1 + now.getHours() / 24) / days) * 100);
}

export function startOfMonth(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

export function findGoal(
  goals: GoalRow[],
  userId: string | null,
  metric: GoalMetric,
  period: GoalPeriod
): number | null {
  const g = goals.find(
    (x) => x.user_id === userId && x.metric === metric && x.period === period
  );
  return g ? Number(g.target) : null;
}

/** "3h 20min", "45min", "—". */
export function formatMinutes(min: number | null | undefined): string {
  if (!min || min < 1) return '—';
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return h ? `${h}h${m ? ` ${m}min` : ''}` : `${m}min`;
}

export interface TimelineRow {
  at: string;
  kind: string;
  label: string | null;
  amount: number | string | null;
  ref_id: string | null;
  ended_at: string | null;
}

/** Drops presence stretches shorter than a minute (a tab flick). */
export function cleanTimeline(rows: TimelineRow[]): TimelineRow[] {
  return rows.filter((r) => {
    if (r.kind !== 'online' && r.kind !== 'away') return true;
    if (!r.ended_at) return false;
    return Date.parse(r.ended_at) - Date.parse(r.at) >= 60_000;
  });
}
