import { describe, expect, it, vi } from 'vitest';

const insertMock = vi.fn();

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    from: () => ({ insert: insertMock }),
  }),
}));

import { audit } from './audit';

describe('audit', () => {
  it('inserts a row with the event fields mapped to their snake_case columns', async () => {
    insertMock.mockResolvedValue({ error: null });

    await audit({
      accountId: 'acc-1',
      actorUserId: 'user-1',
      action: 'channel.created',
      resourceType: 'whatsapp_waha_channel',
      resourceId: 'chan-1',
      metadata: { label: 'Vendas' },
      requestId: 'req-1',
    });

    expect(insertMock).toHaveBeenCalledWith({
      account_id: 'acc-1',
      actor_user_id: 'user-1',
      action: 'channel.created',
      resource_type: 'whatsapp_waha_channel',
      resource_id: 'chan-1',
      metadata: { label: 'Vendas' },
      request_id: 'req-1',
    });
  });

  it('defaults optional fields to null/empty object', async () => {
    insertMock.mockResolvedValue({ error: null });

    await audit({
      accountId: 'acc-1',
      actorUserId: null,
      action: 'broadcast.sent',
      resourceType: 'broadcast',
    });

    expect(insertMock).toHaveBeenCalledWith({
      account_id: 'acc-1',
      actor_user_id: null,
      action: 'broadcast.sent',
      resource_type: 'broadcast',
      resource_id: null,
      metadata: {},
      request_id: null,
    });
  });

  it('never throws when the insert returns an error', async () => {
    insertMock.mockResolvedValue({ error: { message: 'boom' } });

    await expect(
      audit({
        accountId: 'acc-1',
        actorUserId: null,
        action: 'contact.anonymized',
        resourceType: 'contact',
      })
    ).resolves.toBeUndefined();
  });

  it('never throws when the client itself throws', async () => {
    insertMock.mockRejectedValue(new Error('network down'));

    await expect(
      audit({
        accountId: 'acc-1',
        actorUserId: null,
        action: 'member.role_changed',
        resourceType: 'profile',
      })
    ).resolves.toBeUndefined();
  });
});
