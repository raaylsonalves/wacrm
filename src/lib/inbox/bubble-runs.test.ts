import { describe, it, expect } from 'vitest';
import { startsRun, unseenCount } from './bubble-runs';

const m = (sender_type: string, min: number) => ({
  sender_type,
  created_at: new Date(Date.UTC(2026, 0, 1, 12, min)).toISOString(),
});

describe('startsRun', () => {
  it('first message opens a run', () =>
    expect(startsRun(null, m('customer', 0))).toBe(true));
  it('same side, close in time, continues', () =>
    expect(startsRun(m('customer', 0), m('customer', 2))).toBe(false));
  it('agent and bot are the same side', () =>
    expect(startsRun(m('agent', 0), m('bot', 1))).toBe(false));
  it('switching side opens a run', () =>
    expect(startsRun(m('customer', 0), m('agent', 1))).toBe(true));
  it('a long pause opens a run', () =>
    expect(startsRun(m('customer', 0), m('customer', 30))).toBe(true));
});

describe('unseenCount', () => {
  it('counts only customer messages after the seen mark', () => {
    const list = [
      m('customer', 0),
      m('agent', 1),
      m('customer', 2),
      m('bot', 3),
      m('customer', 4),
    ];
    expect(unseenCount(list, 2)).toBe(2);
    expect(unseenCount(list, 5)).toBe(0);
    expect(unseenCount(list, 99)).toBe(0);
  });
});
