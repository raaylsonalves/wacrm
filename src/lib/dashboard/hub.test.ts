import { describe, expect, it } from 'vitest';
import { buildFeed, rankTeam } from './hub';

const r = (name: string, won_value = 0, deals_won = 0, appointments = 0, replies = 0) => ({ user_id: name, name, won_value, deals_won, appointments, replies });

describe('rankTeam', () => {
  it('orders by value, then deals, appointments, replies; drops idle', () => {
    const out = rankTeam([r('Ana', 0, 0, 0, 30), r('Bia', 500, 1), r('Caio'), r('Duda', 500, 2), r('Eli', 0, 0, 3)]);
    expect(out.map((x) => x.name)).toEqual(['Duda', 'Bia', 'Eli', 'Ana']);
  });
});

describe('buildFeed', () => {
  it('newest first, capped', () => {
    const items = [1, 3, 2].map((h) => ({ at: `2026-10-16T1${h}:00:00Z`, kind: 'lead' as const, who: null, title: String(h) }));
    expect(buildFeed(items, 2).map((i) => i.title)).toEqual(['3', '2']);
  });
});
