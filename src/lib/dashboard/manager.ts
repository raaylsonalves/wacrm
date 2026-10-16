// The manager's view of the team (specs/painel-gestor.md, migration 133).
// Rows come from team_live / team_performance / attention_items and the
// service_responses of migration 127; every number on the screen is
// shaped here so it can be unit-tested without Supabase.

import { perResponder, type ResponseRow } from '@/lib/analytics/service';

export type Presence = 'online' | 'away' | 'offline';

export interface TeamLiveRow {
  user_id: string;
  full_name: string | null;
  account_role: string;
  presence: Presence;
  last_seen_at: string | null;
  open_count: number;
  waiting_count: number;
  oldest_wait_at: string | null;
  replies_since: number;
}

export interface TeamPerformanceRow {
  user_id: string;
  conversations: number;
  replies: number;
  deals_won: number;
  won_value: number | string;
  appointments: number;
}

export interface AttentionRow {
  conversation_id: string;
  contact_name: string | null;
  contact_phone: string | null;
  assigned_agent_id: string | null;
  waiting_since: string;
  reason: 'late' | 'unassigned' | 'ai_handoff';
  handoff_reason: string | null;
}

/** Minutes since an instant, never negative. */
export function minutesSince(iso: string | null, now: Date): number | null {
  if (!iso) return null;
  return Math.max(0, Math.floor((now.getTime() - Date.parse(iso)) / 60_000));
}

/** Local midnight of `now` (the browser's zone, like the service report). */
export function startOfToday(now: Date): Date {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d;
}

export interface LiveMemberView {
  userId: string;
  name: string;
  presence: Presence;
  open: number;
  waiting: number;
  oldestWaitMinutes: number | null;
  repliesToday: number;
  medianMinutesToday: number | null;
  /** Someone waits on them longer than the target, or they reply slower. */
  late: boolean;
}

/**
 * "Your team now": presence, load and today's speed per person, the busiest
 * and slowest first so a manager sees the problem at the top.
 */
export function liveTeam(
  live: TeamLiveRow[],
  todayResponses: ResponseRow[],
  targetMinutes: number,
  now: Date
): LiveMemberView[] {
  const speed = new Map(perResponder(todayResponses, targetMinutes).map((s) => [s.key, s]));
  return live
    .map((m) => {
      const oldest = minutesSince(m.oldest_wait_at, now);
      const median = speed.get(m.user_id)?.medianMinutes ?? null;
      return {
        userId: m.user_id,
        name: m.full_name?.trim() || '—',
        presence: m.presence,
        open: Number(m.open_count),
        waiting: Number(m.waiting_count),
        oldestWaitMinutes: oldest,
        repliesToday: Number(m.replies_since),
        medianMinutesToday: median,
        late: (oldest !== null && oldest > targetMinutes) || (median !== null && median > targetMinutes),
      };
    })
    .sort((a, b) => Number(b.late) - Number(a.late) || b.waiting - a.waiting || b.open - a.open);
}

export interface PerformanceView {
  userId: string;
  name: string;
  conversations: number;
  replies: number;
  medianMinutes: number | null;
  withinTargetPct: number | null;
  waitingNow: number;
  dealsWon: number;
  wonValue: number;
  appointments: number;
}

/** "Who did what" for a period, most conversations first. */
export function teamPerformance(
  perf: TeamPerformanceRow[],
  live: TeamLiveRow[],
  responses: ResponseRow[],
  targetMinutes: number
): PerformanceView[] {
  const speed = new Map(perResponder(responses, targetMinutes).map((s) => [s.key, s]));
  const byUser = new Map(live.map((m) => [m.user_id, m]));
  return perf
    .map((p) => {
      const m = byUser.get(p.user_id);
      const s = speed.get(p.user_id);
      return {
        userId: p.user_id,
        name: m?.full_name?.trim() || '—',
        conversations: Number(p.conversations),
        replies: Number(p.replies),
        medianMinutes: s?.medianMinutes ?? null,
        withinTargetPct: s?.withinTargetPct ?? null,
        waitingNow: Number(m?.waiting_count ?? 0),
        dealsWon: Number(p.deals_won),
        wonValue: Number(p.won_value),
        appointments: Number(p.appointments),
      };
    })
    .sort((a, b) => b.conversations - a.conversations || b.wonValue - a.wonValue);
}

/** Percent change, rounded; null when there is nothing to compare with. */
export function changePct(current: number, previous: number): number | null {
  if (previous <= 0) return null;
  return Math.round(((current - previous) / previous) * 100);
}
