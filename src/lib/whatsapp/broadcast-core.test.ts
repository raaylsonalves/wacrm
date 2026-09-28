import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  createBroadcast,
  deliverBroadcast,
  finalizeBroadcastStatus,
  BroadcastError,
  type BroadcastPlan,
} from './broadcast-core';

// Contact resolution and token decryption are exercised elsewhere — stub
// them so these tests focus on the persistence boundary.
vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: () => 'plain-access-token',
}));
vi.mock('@/lib/api/v1/contacts', () => ({
  findOrCreateContact: vi.fn(async () => ({ id: 'c1' })),
}));

const h = vi.hoisted(() => ({
  sendWahaText: vi.fn(),
  claimWahaSendSlot: vi.fn(),
  pickNextChannel: vi.fn(),
}));
vi.mock('@/lib/whatsapp/waha-api', async () => {
  const actual = await vi.importActual<typeof import('./waha-api')>('./waha-api');
  return { ...actual, sendWahaText: h.sendWahaText };
});
vi.mock('@/lib/whatsapp/waha-throttle', async () => {
  const actual =
    await vi.importActual<typeof import('./waha-throttle')>('./waha-throttle');
  return { ...actual, claimWahaSendSlot: h.claimWahaSendSlot };
});
vi.mock('@/lib/whatsapp/broadcast-rotation', () => ({
  pickNextChannel: h.pickNextChannel,
}));

// These assertions all fire in the pure validation prologue, before
// any Supabase call — a bare stub is enough.
const db = {} as SupabaseClient;

describe('createBroadcast validation', () => {
  it('rejects a missing template_name', async () => {
    await expect(
      createBroadcast(db, 'acc', 'user', {
        templateName: '',
        recipients: [{ to: '+14155550123' }],
      })
    ).rejects.toMatchObject({ code: 'bad_request', status: 400 });
  });

  it('rejects an empty recipient list', async () => {
    await expect(
      createBroadcast(db, 'acc', 'user', {
        templateName: 'promo',
        recipients: [],
      })
    ).rejects.toBeInstanceOf(BroadcastError);
  });

  it('rejects more than 1000 recipients', async () => {
    const recipients = Array.from({ length: 1001 }, () => ({
      to: '+14155550123',
    }));
    await expect(
      createBroadcast(db, 'acc', 'user', { templateName: 'promo', recipients })
    ).rejects.toMatchObject({ status: 400 });
  });
});

// Build a Supabase-shaped mock that gets createBroadcast past its config +
// template lookups and into persistence. `rpcResult` is what the atomic
// create_broadcast_with_recipients RPC returns.
function makeDb(rpcResult: { data: unknown; error: unknown }) {
  const calls = {
    rpc: [] as { name: string; args: unknown }[],
    // Incremented if the OLD non-atomic path (a direct broadcasts /
    // broadcast_recipients insert) is ever reached — it must not be.
    usedDirectInsert: 0,
  };
  const database = {
    from(table: string) {
      if (table === 'whatsapp_config') {
        return {
          select: () => ({
            eq: () => ({
              single: () =>
                Promise.resolve({
                  data: { phone_number_id: 'pn-1', access_token: 'enc' },
                  error: null,
                }),
            }),
          }),
        };
      }
      if (table === 'message_templates') {
        const chain: Record<string, unknown> = {
          select: () => chain,
          eq: () => chain,
          maybeSingle: () => Promise.resolve({ data: null, error: null }),
        };
        return chain;
      }
      if (table === 'broadcasts' || table === 'broadcast_recipients') {
        calls.usedDirectInsert++;
        return {
          insert: () => ({
            select: () => ({
              single: () =>
                Promise.resolve({ data: { id: 'orphan' }, error: null }),
            }),
          }),
        };
      }
      throw new Error(`unexpected table: ${table}`);
    },
    rpc(name: string, args: unknown) {
      calls.rpc.push({ name, args });
      return Promise.resolve(rpcResult);
    },
  } as unknown as SupabaseClient;
  return { db: database, calls };
}

describe('createBroadcast atomicity (#370)', () => {
  it('creates parent + recipients through the atomic RPC, never a bare parent insert', async () => {
    const { db, calls } = makeDb({
      data: [{ broadcast_id: 'b-1', recipient_id: 'r-1', contact_id: 'c1' }],
      error: null,
    });

    const plan = await createBroadcast(db, 'acc', 'user', {
      templateName: 'promo',
      recipients: [{ to: '+14155550123' }],
    });

    expect(calls.rpc).toHaveLength(1);
    expect(calls.rpc[0].name).toBe('create_broadcast_with_recipients');
    expect(calls.usedDirectInsert).toBe(0);
    expect(plan.broadcastId).toBe('b-1');
    expect(plan.planned).toEqual([
      { recipientRowId: 'r-1', phone: '14155550123', params: [] },
    ]);
  });

  it('throws and leaves no orphaned parent when the atomic create fails', async () => {
    const { db, calls } = makeDb({
      data: null,
      error: { message: 'recipient insert failed' },
    });

    await expect(
      createBroadcast(db, 'acc', 'user', {
        templateName: 'promo',
        recipients: [{ to: '+14155550123' }],
      })
    ).rejects.toBeInstanceOf(BroadcastError);

    // The RPC was the only persistence attempt; because it runs both
    // inserts in a single transaction, its failure rolls the parent back —
    // there is no separate parent insert that could survive as an orphan.
    expect(calls.rpc).toHaveLength(1);
    expect(calls.usedDirectInsert).toBe(0);
  });
});

// ============================================================
// Terminal status (#472). Derived from the recipient rows, not from a
// counter local to one delivery pass — a resume only sends the
// leftovers, so "nothing sent this pass" must not condemn a campaign
// that already delivered hundreds.
// ============================================================

function statusDb(
  counts: Record<string, number>,
  total: number,
  writes: { update?: Record<string, unknown> },
) {
  return {
    from(table: string) {
      let status: string | null = null;
      const b: Record<string, unknown> = {
        select: () => b,
        eq: (col: string, val: unknown) => {
          if (col === 'status') status = val as string;
          return b;
        },
        update: (row: Record<string, unknown>) => {
          if (table === 'broadcasts') writes.update = row;
          return b;
        },
        then: (resolve: (r: { count: number; error: null }) => unknown) =>
          resolve({
            count: status === null ? total : (counts[status] ?? 0),
            error: null,
          }),
      };
      return b;
    },
  } as unknown as SupabaseClient;
}

// ============================================================
// WAHA broadcasts (specs/broadcast-channel-rotation.md) — the
// primaryChannelId branch skips whatsapp_config entirely and
// validates channel ownership instead.
// ============================================================

function makeWahaDb(opts: {
  ownedChannelIds: string[];
  templateBodyText: string | null;
  rpcResult: { data: unknown; error: unknown };
}) {
  const calls = {
    rpc: [] as { name: string; args: unknown }[],
    poolInsert: null as unknown,
    touchedWhatsappConfig: false,
  };
  const database = {
    from(table: string) {
      if (table === 'whatsapp_config') {
        calls.touchedWhatsappConfig = true;
        throw new Error('a WAHA broadcast must never query whatsapp_config');
      }
      if (table === 'whatsapp_waha_channels') {
        return {
          select: () => ({
            eq: () => ({
              in: (_col: string, ids: string[]) =>
                Promise.resolve({
                  data: ids
                    .filter((id) => opts.ownedChannelIds.includes(id))
                    .map((id) => ({ id })),
                  error: null,
                }),
            }),
          }),
        };
      }
      if (table === 'message_templates') {
        const rows =
          opts.templateBodyText === null
            ? []
            : [
                {
                  id: 'tmpl-1',
                  user_id: 'user',
                  name: 'promo',
                  language: 'en_US',
                  body_text: opts.templateBodyText,
                },
              ];
        // resolveTemplateRow's actual shape: select('*').eq().eq(),
        // resolved directly (no .maybeSingle()) — `eq` both chains
        // (for the 2nd .eq() call) and resolves (when awaited), since
        // the real query builder is exactly this "thenable that keeps
        // chaining" shape.
        const result = Promise.resolve({ data: rows, error: null });
        const eqChain = { eq: () => eqChain, then: result.then.bind(result) };
        const chain: Record<string, unknown> = {
          select: () => chain,
          eq: () => eqChain,
        };
        return chain;
      }
      if (table === 'broadcast_channel_pool') {
        return {
          insert: (rows: unknown) => {
            calls.poolInsert = rows;
            return Promise.resolve({ error: null });
          },
        };
      }
      throw new Error(`unexpected table: ${table}`);
    },
    rpc(name: string, args: unknown) {
      calls.rpc.push({ name, args });
      return Promise.resolve(opts.rpcResult);
    },
  } as unknown as SupabaseClient;
  return { db: database, calls };
}

describe('createBroadcast — WAHA channel', () => {
  it('never queries whatsapp_config when primaryChannelId is set', async () => {
    const { db, calls } = makeWahaDb({
      ownedChannelIds: ['chan-1', 'chan-2'],
      templateBodyText: 'Hello {{1}}',
      rpcResult: {
        data: [{ broadcast_id: 'b-1', recipient_id: 'r-1', contact_id: 'c1' }],
        error: null,
      },
    });

    const plan = await createBroadcast(db, 'acc', 'user', {
      templateName: 'promo',
      recipients: [{ to: '+14155550123' }],
      primaryChannelId: 'chan-1',
      channelPoolIds: ['chan-2'],
    });

    expect(calls.touchedWhatsappConfig).toBe(false);
    expect(plan.primaryChannelId).toBe('chan-1');
    expect(plan.channelPoolIds).toEqual(['chan-2']);
    expect(calls.rpc[0].args).toMatchObject({ p_primary_channel_id: 'chan-1' });
    expect(calls.poolInsert).toEqual([{ broadcast_id: 'b-1', waha_channel_id: 'chan-2' }]);
  });

  it('rejects a channel id that does not belong to this account', async () => {
    const { db } = makeWahaDb({
      ownedChannelIds: ['chan-1'],
      templateBodyText: 'Hello',
      rpcResult: { data: null, error: null },
    });

    await expect(
      createBroadcast(db, 'acc', 'user', {
        templateName: 'promo',
        recipients: [{ to: '+14155550123' }],
        primaryChannelId: 'chan-1',
        channelPoolIds: ['someone-elses-channel'],
      })
    ).rejects.toMatchObject({ code: 'bad_request', status: 400 });
  });

  it('rejects a template with no locally-synced body text', async () => {
    const { db } = makeWahaDb({
      ownedChannelIds: ['chan-1'],
      templateBodyText: null,
      rpcResult: { data: null, error: null },
    });

    await expect(
      createBroadcast(db, 'acc', 'user', {
        templateName: 'promo',
        recipients: [{ to: '+14155550123' }],
        primaryChannelId: 'chan-1',
      })
    ).rejects.toMatchObject({ code: 'template_not_synced', status: 400 });
  });
});

describe('deliverBroadcast — WAHA channel', () => {
  function wahaPlan(overrides: Partial<BroadcastPlan> = {}): BroadcastPlan {
    return {
      broadcastId: 'b-1',
      templateName: 'promo',
      templateLanguage: 'en_US',
      phoneNumberId: '',
      accessToken: '',
      templateRow: { body_text: 'Hello {{1}}' } as BroadcastPlan['templateRow'],
      primaryChannelId: 'chan-1',
      channelPoolIds: ['chan-2'],
      planned: [{ recipientRowId: 'r-1', phone: '14155550123', params: ['Ana'] }],
      rejected: 0,
      ...overrides,
    };
  }

  // Permissive: deliverBroadcast's own recipient update is captured via
  // `onUpdate`; everything downstream of it (finalizeBroadcastStatus's
  // count queries against broadcast_recipients, then its status update
  // on broadcasts) just needs to resolve without throwing — it's
  // covered by its own dedicated `describe('finalizeBroadcastStatus')`
  // block above, not re-verified here.
  function recipientUpdateDb(onUpdate: (row: Record<string, unknown>) => void) {
    const resolved = Promise.resolve({ data: null, error: null, count: 0 });
    const chain: Record<string, unknown> = {
      eq: () => chain,
      select: () => chain,
      update: () => chain,
      then: resolved.then.bind(resolved),
    };
    return {
      from: (table: string) => {
        if (table === 'broadcast_recipients') {
          return {
            ...chain,
            update: (row: Record<string, unknown>) => {
              onUpdate(row);
              return { eq: () => Promise.resolve({ error: null }) };
            },
          };
        }
        return chain;
      },
    } as unknown as SupabaseClient;
  }

  it('sends via the picked channel and stamps sent_via_channel_id', async () => {
    h.pickNextChannel.mockResolvedValue({
      id: 'chan-2',
      waha_base_url: 'https://waha.example.com',
      waha_api_key: 'enc',
      waha_session_name: 'sess-2',
      connected_at: '2026-01-01T00:00:00Z',
    });
    h.claimWahaSendSlot.mockResolvedValue(undefined);
    h.sendWahaText.mockResolvedValue({ id: 'wamid-1' });

    let updated: Record<string, unknown> | null = null;
    await deliverBroadcast(
      recipientUpdateDb((row) => {
        updated = row;
      }),
      wahaPlan()
    );

    expect(h.sendWahaText).toHaveBeenCalledWith(
      'https://waha.example.com',
      'plain-access-token',
      'sess-2',
      '14155550123@c.us',
      'Hello Ana'
    );
    expect(updated).toMatchObject({ status: 'sent', sent_via_channel_id: 'chan-2' });
  });

  it('fails the recipient when no channel in the pool is connected', async () => {
    h.pickNextChannel.mockResolvedValue(null);

    let updated: Record<string, unknown> | null = null;
    await deliverBroadcast(
      recipientUpdateDb((row) => {
        updated = row;
      }),
      wahaPlan()
    );

    expect(h.sendWahaText).not.toHaveBeenCalled();
    expect(updated).toMatchObject({ status: 'failed' });
  });

  it('fails the recipient when the send throws, without retrying phone variants', async () => {
    h.pickNextChannel.mockResolvedValue({
      id: 'chan-1',
      waha_base_url: 'https://waha.example.com',
      waha_api_key: 'enc',
      waha_session_name: 'sess-1',
      connected_at: null,
    });
    h.claimWahaSendSlot.mockResolvedValue(undefined);
    h.sendWahaText.mockRejectedValue(new Error('WAHA down'));

    let updated: Record<string, unknown> | null = null;
    await deliverBroadcast(
      recipientUpdateDb((row) => {
        updated = row;
      }),
      wahaPlan()
    );

    expect(h.sendWahaText).toHaveBeenCalledTimes(1);
    expect(updated).toMatchObject({ status: 'failed', error_message: 'WAHA down' });
  });
});

describe('finalizeBroadcastStatus', () => {
  it('leaves a capped pass in "sending" while recipients are still pending', async () => {
    const writes: { update?: Record<string, unknown> } = {};
    await finalizeBroadcastStatus(statusDb({ pending: 25 }, 1025, writes), 'b-1');
    // No write at all — the UI keeps offering Resume.
    expect(writes.update).toBeUndefined();
  });

  it('marks a fully-failed broadcast failed', async () => {
    const writes: { update?: Record<string, unknown> } = {};
    await finalizeBroadcastStatus(
      statusDb({ pending: 0, failed: 10 }, 10, writes),
      'b-1',
    );
    expect(writes.update?.status).toBe('failed');
  });

  it('marks a partially-failed broadcast sent', async () => {
    const writes: { update?: Record<string, unknown> } = {};
    await finalizeBroadcastStatus(
      statusDb({ pending: 0, failed: 3 }, 10, writes),
      'b-1',
    );
    // 7 people got the message; failed_count carries the other 3.
    expect(writes.update?.status).toBe('sent');
  });

  it('does not condemn a campaign whose resume pass sent nothing new', async () => {
    const writes: { update?: Record<string, unknown> } = {};
    // 800 delivered on the original pass, the 200-recipient resume all
    // failed. Pre-fix this wrote 'failed' off a pass-local counter.
    await finalizeBroadcastStatus(
      statusDb({ pending: 0, failed: 200 }, 1000, writes),
      'b-1',
    );
    expect(writes.update?.status).toBe('sent');
  });
});
