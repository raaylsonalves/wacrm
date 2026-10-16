import { describe, expect, it } from 'vitest';
import {
  changePct,
  liveTeam,
  minutesSince,
  teamPerformance,
  type TeamLiveRow,
} from './manager';
import type { ResponseRow } from '@/lib/analytics/service';

const now = new Date('2026-10-16T17:30:00Z');
const member = (over: Partial<TeamLiveRow>): TeamLiveRow => ({
  user_id: 'u1',
  full_name: 'Ana',
  account_role: 'agent',
  presence: 'online',
  last_seen_at: null,
  open_count: 0,
  waiting_count: 0,
  oldest_wait_at: null,
  replies_since: 0,
  ...over,
});
const reply = (user: string, mins: number): ResponseRow => ({
  conversation_id: 'c',
  customer_at: '2026-10-16T12:00:00Z',
  replied_at: new Date(
    Date.parse('2026-10-16T12:00:00Z') + mins * 60_000
  ).toISOString(),
  reply_kind: 'human',
  reply_user_id: user,
});

describe('liveTeam', () => {
  it('puts whoever is late on top', () => {
    const rows = liveTeam(
      [
        member({
          user_id: 'a',
          full_name: 'Ana',
          open_count: 9,
          waiting_count: 1,
        }),
        member({
          user_id: 'b',
          full_name: 'Bruno',
          open_count: 3,
          waiting_count: 2,
          oldest_wait_at: '2026-10-16T17:00:00Z',
        }),
      ],
      [reply('a', 2)],
      10,
      now
    );
    expect(rows.map((r) => r.name)).toEqual(['Bruno', 'Ana']);
    expect(rows[0]).toMatchObject({ late: true, oldestWaitMinutes: 30 });
    expect(rows[1]).toMatchObject({ late: false, medianMinutesToday: 2 });
  });
});

describe('teamPerformance', () => {
  it('joins counts, speed and names', () => {
    const rows = teamPerformance(
      [
        {
          user_id: 'a',
          conversations: 5,
          replies: 20,
          deals_won: 2,
          won_value: '900.50',
          appointments: 3,
        },
      ],
      [member({ user_id: 'a', full_name: 'Ana', waiting_count: 1 })],
      [reply('a', 4), reply('a', 20)],
      10
    );
    expect(rows[0]).toMatchObject({
      name: 'Ana',
      wonValue: 900.5,
      withinTargetPct: 50,
      waitingNow: 1,
    });
  });
});

describe('helpers', () => {
  it('minutesSince and changePct', () => {
    expect(minutesSince('2026-10-16T17:00:00Z', now)).toBe(30);
    expect(minutesSince(null, now)).toBeNull();
    expect(changePct(112, 100)).toBe(12);
    expect(changePct(5, 0)).toBeNull();
  });
});
