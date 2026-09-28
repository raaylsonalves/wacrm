import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { pickNextChannel } from './broadcast-rotation';

function makeDb(rows: unknown[]) {
  return {
    from: () => ({
      select: () => ({
        in: () => ({
          eq: () => ({
            order: () => ({
              limit: () => Promise.resolve({ data: rows, error: null }),
            }),
          }),
        }),
      }),
    }),
  } as unknown as SupabaseClient;
}

describe('pickNextChannel', () => {
  it('returns the one channel returned by the query', async () => {
    const channel = {
      id: 'chan-1',
      waha_base_url: 'https://waha.example.com',
      waha_api_key: 'enc',
      waha_session_name: 'sess-1',
      connected_at: '2026-01-01T00:00:00Z',
    };
    const db = makeDb([channel]);
    const result = await pickNextChannel(db, 'chan-1', ['chan-2']);
    expect(result).toEqual(channel);
  });

  it('returns null when no candidate is connected', async () => {
    const db = makeDb([]);
    const result = await pickNextChannel(db, 'chan-1', []);
    expect(result).toBeNull();
  });

  it('returns null on a query error rather than throwing', async () => {
    const db = {
      from: () => ({
        select: () => ({
          in: () => ({
            eq: () => ({
              order: () => ({
                limit: () =>
                  Promise.resolve({ data: null, error: { message: 'boom' } }),
              }),
            }),
          }),
        }),
      }),
    } as unknown as SupabaseClient;
    const result = await pickNextChannel(db, 'chan-1', []);
    expect(result).toBeNull();
  });

  it('deduplicates the primary against the pool before querying', async () => {
    let seenIds: string[] = [];
    const db = {
      from: () => ({
        select: () => ({
          in: (_col: string, ids: string[]) => {
            seenIds = ids;
            return {
              eq: () => ({
                order: () => ({
                  limit: () => Promise.resolve({ data: [], error: null }),
                }),
              }),
            };
          },
        }),
      }),
    } as unknown as SupabaseClient;
    await pickNextChannel(db, 'chan-1', ['chan-1', 'chan-2']);
    expect(seenIds).toEqual(['chan-1', 'chan-2']);
  });
});
