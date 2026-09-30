import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/whatsapp/broadcast-core', () => ({
  BroadcastError: class extends Error {
    code: string;
    constructor(code: string) {
      super(code);
      this.code = code;
    }
  },
  deliverBroadcast: vi.fn(),
  finalizeBroadcastStatus: vi.fn(),
}));
vi.mock('@/lib/whatsapp/broadcast-resume', () => ({
  claimBroadcastDelivery: vi.fn(async () => true),
  planBroadcastResume: vi.fn(async () => ({
    plan: { planned: [] },
    remaining: 0,
  })),
  releaseBroadcastDelivery: vi.fn(),
}));

import {
  canCancelBroadcast,
  optedOutRecipientIds,
  runScheduledBroadcasts,
  validScheduleTime,
} from './broadcast-schedule';
import { deliverBroadcast } from '@/lib/whatsapp/broadcast-core';

describe('scheduling rules', () => {
  const now = Date.UTC(2026, 8, 30, 12, 0);
  it('needs at least 5 minutes of lead time', () => {
    expect(
      validScheduleTime(new Date(now + 10 * 60_000).toISOString(), now)
    ).toBe(true);
    expect(validScheduleTime(new Date(now + 60_000).toISOString(), now)).toBe(
      false
    );
    expect(validScheduleTime(new Date(now - 60_000).toISOString(), now)).toBe(
      false
    );
    expect(validScheduleTime('', now)).toBe(false);
  });

  it('only a scheduled broadcast can be cancelled', () => {
    expect(canCancelBroadcast('scheduled')).toBe(true);
    for (const s of ['sending', 'sent', 'failed', 'draft', 'cancelled']) {
      expect(canCancelBroadcast(s)).toBe(false);
    }
  });

  it('finds recipients who opted out after scheduling', () => {
    expect(
      optedOutRecipientIds([
        { id: 'a', contact: { opted_out_at: '2026-09-29T10:00:00Z' } },
        { id: 'b', contact: { opted_out_at: null } },
        { id: 'c', contact: [{ opted_out_at: '2026-09-29T10:00:00Z' }] },
      ])
    ).toEqual(['a', 'c']);
  });
});

/**
 * db whose broadcasts claim succeeds only the first time — a second cron
 * run on the same broadcast finds it already out of 'scheduled'.
 */
function fakeDb() {
  let claimed = false;
  const chain = (result: () => unknown) => {
    const q: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'lte', 'order', 'limit', 'in', 'update'])
      q[m] = () => q;
    (q as { then: unknown }).then = (res: (v: unknown) => unknown) =>
      Promise.resolve(result()).then(res);
    return q;
  };
  return {
    from: (table: string) => ({
      select: () =>
        chain(() =>
          table === 'broadcasts'
            ? { data: claimed ? [] : [{ id: 'b1', account_id: 'a1' }] }
            : { data: [] }
        ),
      update: () =>
        chain(() => {
          if (table === 'broadcasts' && !claimed) {
            claimed = true;
            return { data: [{ id: 'b1' }] };
          }
          return { data: [] };
        }),
    }),
  } as never;
}

describe('runScheduledBroadcasts', () => {
  it('sends a due broadcast once, even if the cron runs twice', async () => {
    const db = fakeDb();
    const first = await runScheduledBroadcasts(db);
    const second = await runScheduledBroadcasts(db);
    expect(first.started).toBe(1);
    expect(first.finished).toBe(1);
    expect(second.started).toBe(0);
    expect(deliverBroadcast).toHaveBeenCalledTimes(1);
  });
});
