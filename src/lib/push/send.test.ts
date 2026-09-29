import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  getVapidConfig,
  isGoneError,
  pushRecipientFilter,
  sendPushToAccount,
  type SubscriptionRow,
} from './send';

const rows: SubscriptionRow[] = [
  {
    id: 's1',
    user_id: 'u1',
    endpoint: 'https://push/1',
    p256dh: 'p',
    auth_key: 'a',
  },
  {
    id: 's2',
    user_id: 'u2',
    endpoint: 'https://push/2',
    p256dh: 'p',
    auth_key: 'a',
  },
  {
    id: 's3',
    user_id: 'u3',
    endpoint: 'https://push/3',
    p256dh: 'p',
    auth_key: 'a',
  },
];

function fakeDb(data: SubscriptionRow[] = rows) {
  const deleted: string[][] = [];
  const db = {
    from: () => ({
      select: () => ({
        eq: async () => ({ data, error: null }),
      }),
      delete: () => ({
        in: async (_col: string, ids: string[]) => {
          deleted.push(ids);
          return { error: null };
        },
      }),
    }),
  } as unknown as SupabaseClient;
  return { db, deleted };
}

const payload = {
  title: 't',
  body: 'b',
  conversationId: 'c1',
  url: '/inbox?c=c1',
};

describe('sendPushToAccount', () => {
  it('deletes subscriptions the push service reports gone (404/410), keeps transient failures', async () => {
    const { db, deleted } = fakeDb();
    const sender = vi.fn(async (sub: SubscriptionRow) => {
      if (sub.id === 's1')
        throw Object.assign(new Error('gone'), { statusCode: 410 });
      if (sub.id === 's2')
        throw Object.assign(new Error('nope'), { statusCode: 404 });
    });
    const res = await sendPushToAccount(db, 'acc', payload, {
      sender,
      vapid: null,
    });
    expect(res).toEqual({ sent: 1, removed: 2, failed: 0 });
    expect(deleted).toEqual([expect.arrayContaining(['s1', 's2'])]);
  });

  it('does not delete on a transient error (5xx / 429)', async () => {
    const { db, deleted } = fakeDb();
    const sender = vi.fn(async () => {
      throw Object.assign(new Error('busy'), { statusCode: 503 });
    });
    const res = await sendPushToAccount(db, 'acc', payload, {
      sender,
      vapid: null,
    });
    expect(res).toEqual({ sent: 0, removed: 0, failed: 3 });
    expect(deleted).toEqual([]);
  });

  it('pushes only the assignee when the conversation is assigned', async () => {
    const { db } = fakeDb();
    const sender = vi.fn<(sub: SubscriptionRow, body: string) => Promise<void>>(
      async () => {}
    );
    await sendPushToAccount(db, 'acc', payload, {
      sender,
      vapid: null,
      onlyUserId: 'u2',
    });
    expect(sender).toHaveBeenCalledTimes(1);
    const [sub, body] = sender.mock.calls[0]!;
    expect(sub.id).toBe('s2');
    expect(JSON.parse(body)).toEqual(payload);
  });

  it('is a no-op with no VAPID config and no injected sender', async () => {
    const { db } = fakeDb();
    const res = await sendPushToAccount(db, 'acc', payload, { vapid: null });
    expect(res).toEqual({ sent: 0, removed: 0, failed: 0 });
  });
});

describe('helpers', () => {
  it('isGoneError only for 404/410', () => {
    expect(isGoneError({ statusCode: 410 })).toBe(true);
    expect(isGoneError({ statusCode: 404 })).toBe(true);
    expect(isGoneError({ statusCode: 500 })).toBe(false);
    expect(isGoneError(new Error('x'))).toBe(false);
  });

  it('pushRecipientFilter: unassigned → everyone', () => {
    expect(rows.filter(pushRecipientFilter(null))).toHaveLength(3);
  });

  it('getVapidConfig requires all three vars', () => {
    expect(getVapidConfig({})).toBeNull();
    expect(
      getVapidConfig({
        NEXT_PUBLIC_VAPID_PUBLIC_KEY: 'a',
        VAPID_PRIVATE_KEY: 'b',
      })
    ).toBeNull();
    expect(
      getVapidConfig({
        NEXT_PUBLIC_VAPID_PUBLIC_KEY: 'a',
        VAPID_PRIVATE_KEY: 'b',
        VAPID_SUBJECT: 'mailto:x@y.z',
      })
    ).toEqual({ publicKey: 'a', privateKey: 'b', subject: 'mailto:x@y.z' });
  });
});
