import { describe, expect, it } from 'vitest';
import { cleanTimeline, findGoal, formatMinutes, metricValue, monthPace, progressPct } from './goals';

describe('goals', () => {
  it('progress and values', () => {
    expect(progressPct(50, 200)).toBe(25);
    expect(progressPct(5, 0)).toBeNull();
    expect(metricValue({ conversations: 3, deals_won: '2', won_value: '900.5', appointments: 0 }, 'won_value')).toBe(900.5);
    expect(metricValue(undefined, 'deals_won')).toBe(0);
  });
  it('findGoal matches person, metric and period; null = team', () => {
    const goals = [
      { user_id: null, metric: 'won_value' as const, period: 'month' as const, target: '10000' },
      { user_id: 'u1', metric: 'won_value' as const, period: 'day' as const, target: 500 },
    ];
    expect(findGoal(goals, null, 'won_value', 'month')).toBe(10000);
    expect(findGoal(goals, 'u1', 'won_value', 'day')).toBe(500);
    expect(findGoal(goals, 'u1', 'won_value', 'month')).toBeNull();
  });
  it('monthPace is ~50% mid-month', () => {
    expect(monthPace(new Date(2026, 9, 16, 12))).toBe(50);
  });
  it('formatMinutes', () => {
    expect(formatMinutes(200)).toBe('3h 20min');
    expect(formatMinutes(45)).toBe('45min');
    expect(formatMinutes(120)).toBe('2h');
    expect(formatMinutes(0)).toBe('—');
  });
  it('cleanTimeline drops sub-minute presence', () => {
    const rows = cleanTimeline([
      { at: '2026-10-16T10:00:00Z', kind: 'online', label: null, amount: null, ref_id: null, ended_at: '2026-10-16T10:00:20Z' },
      { at: '2026-10-16T11:00:00Z', kind: 'online', label: null, amount: null, ref_id: null, ended_at: '2026-10-16T12:00:00Z' },
      { at: '2026-10-16T11:00:00Z', kind: 'replies', label: null, amount: 4, ref_id: null, ended_at: null },
    ]);
    expect(rows).toHaveLength(2);
  });
});
