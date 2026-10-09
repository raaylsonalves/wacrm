import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  findConversationOnNumber,
  numberColumns,
} from './conversation-number';

interface Conv {
  id: string;
  contact_id: string;
  whatsapp_channel_id: string | null;
  whatsapp_config_id: string | null;
  created_at: string;
}

/** A tiny in-memory `conversations` table honouring eq / is / order / limit. */
function fakeDb(rows: Conv[], primary: string | null = 'n1') {
  const updates: { id: string; patch: Partial<Conv> }[] = [];
  const db = {
    from: (table: string) => {
      if (table === 'whatsapp_config') {
        const c = {
          select: () => c,
          eq: () => c,
          maybeSingle: () =>
            Promise.resolve({ data: primary ? { id: primary } : null, error: null }),
        };
        return c;
      }
      const filters: ((r: Conv) => boolean)[] = [];
      let patch: Partial<Conv> | null = null;
      const q = {
        select: () => q,
        update: (p: Partial<Conv>) => {
          patch = p;
          return q;
        },
        eq: (col: keyof Conv | 'account_id', v: unknown) => {
          if (col !== 'account_id') filters.push((r) => r[col as keyof Conv] === v);
          return q;
        },
        is: (col: keyof Conv, v: null) => {
          filters.push((r) => r[col] === v);
          return q;
        },
        order: () => q,
        limit: () => Promise.resolve({ data: run(), error: null }),
        maybeSingle: () => Promise.resolve({ data: run()[0] ?? null, error: null }),
        then: (resolve: (v: unknown) => unknown) => {
          // update(...).eq().is() awaited directly
          for (const r of run()) {
            Object.assign(r, patch);
            updates.push({ id: r.id, patch: patch! });
          }
          return Promise.resolve({ error: null }).then(resolve);
        },
      };
      const run = () =>
        rows
          .filter((r) => filters.every((f) => f(r)))
          .sort((a, b) => a.created_at.localeCompare(b.created_at));
      return q;
    },
  };
  return { db: db as unknown as SupabaseClient, updates };
}

const conv = (over: Partial<Conv>): Conv => ({
  id: 'c',
  contact_id: 'ct',
  whatsapp_channel_id: null,
  whatsapp_config_id: null,
  created_at: '2026-01-01',
  ...over,
});

describe('findConversationOnNumber', () => {
  it('keeps the threads of two official numbers apart', async () => {
    const { db } = fakeDb([
      conv({ id: 'reception', whatsapp_config_id: 'n1' }),
      conv({ id: 'sales', whatsapp_config_id: 'n2' }),
    ]);
    const found = await findConversationOnNumber<{ id: string }>(db, 'a', 'ct', {
      channelId: null,
      configId: 'n2',
    });
    expect(found?.id).toBe('sales');
  });

  it('does not match a WAHA thread when asked for an official number', async () => {
    const { db } = fakeDb([conv({ id: 'waha', whatsapp_channel_id: 'ch1' })]);
    expect(
      await findConversationOnNumber(db, 'a', 'ct', { channelId: null, configId: 'n1' })
    ).toBeNull();
  });

  it('finds a WAHA channel thread by its channel', async () => {
    const { db } = fakeDb([
      conv({ id: 'official', whatsapp_config_id: 'n1' }),
      conv({ id: 'waha', whatsapp_channel_id: 'ch1' }),
    ]);
    const found = await findConversationOnNumber<{ id: string }>(db, 'a', 'ct', {
      channelId: 'ch1',
      configId: null,
    });
    expect(found?.id).toBe('waha');
  });

  it('adopts a pre-114 official thread with no number recorded', async () => {
    const { db, updates } = fakeDb([conv({ id: 'legacy' })]);
    const found = await findConversationOnNumber<{ id: string }>(db, 'a', 'ct', {
      channelId: null,
      configId: 'n1',
    });
    expect(found?.id).toBe('legacy');
    expect(updates).toEqual([{ id: 'legacy', patch: { whatsapp_config_id: 'n1' } }]);
  });

  it('only the primary adopts it, not another number (review 2026-10, M8)', async () => {
    const { db, updates } = fakeDb([conv({ id: 'legacy' })], 'n1');
    expect(
      await findConversationOnNumber(db, 'a', 'ct', { channelId: null, configId: 'n2' })
    ).toBeNull();
    expect(updates).toEqual([]);
  });
});

describe('numberColumns', () => {
  it('stamps the channel, or the official number', () => {
    expect(numberColumns({ channelId: 'ch', configId: 'n1' })).toEqual({
      whatsapp_channel_id: 'ch',
      whatsapp_config_id: null,
    });
    expect(numberColumns({ channelId: null, configId: 'n1' })).toEqual({
      whatsapp_channel_id: null,
      whatsapp_config_id: 'n1',
    });
  });
});
