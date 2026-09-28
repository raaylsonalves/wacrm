import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const rpcMock = vi.fn();

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({ rpc: rpcMock }),
}));

import { claimWahaSendSlot, WahaThrottleError } from './waha-throttle';

describe('claimWahaSendSlot', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    rpcMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves immediately once the RPC claims the slot', async () => {
    rpcMock.mockResolvedValue({ data: true, error: null });

    const done = claimWahaSendSlot('channel-1');
    await vi.runAllTimersAsync();
    await done;

    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(rpcMock).toHaveBeenCalledWith('claim_waha_send_slot', {
      channel_id: 'channel-1',
      min_interval_ms: 1200,
    });
  });

  it('doubles the interval for a channel still in its warm-up window', async () => {
    rpcMock.mockResolvedValue({ data: true, error: null });

    const recentlyConnected = new Date().toISOString();
    const done = claimWahaSendSlot('channel-1', {
      connectedAt: recentlyConnected,
    });
    await vi.runAllTimersAsync();
    await done;

    expect(rpcMock).toHaveBeenCalledWith('claim_waha_send_slot', {
      channel_id: 'channel-1',
      min_interval_ms: 2400,
    });
  });

  it('uses the broadcast interval when isBroadcast is set', async () => {
    rpcMock.mockResolvedValue({ data: true, error: null });

    const done = claimWahaSendSlot('channel-1', { isBroadcast: true });
    await vi.runAllTimersAsync();
    await done;

    expect(rpcMock).toHaveBeenCalledWith('claim_waha_send_slot', {
      channel_id: 'channel-1',
      min_interval_ms: 5000,
    });
  });

  it('retries on a lost claim until one succeeds', async () => {
    rpcMock
      .mockResolvedValueOnce({ data: false, error: null })
      .mockResolvedValueOnce({ data: false, error: null })
      .mockResolvedValueOnce({ data: true, error: null });

    const done = claimWahaSendSlot('channel-1');
    await vi.runAllTimersAsync();
    await done;

    expect(rpcMock).toHaveBeenCalledTimes(3);
  });

  it('throws WahaThrottleError instead of sending unthrottled when the claim never succeeds', async () => {
    rpcMock.mockResolvedValue({ data: false, error: null });

    const done = claimWahaSendSlot('channel-1');
    const assertion = expect(done).rejects.toThrow(WahaThrottleError);
    await vi.runAllTimersAsync();
    await assertion;
  });

  it('throws WahaThrottleError when the RPC itself errors, rather than sending unthrottled', async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: { message: 'function not found' },
    });

    const done = claimWahaSendSlot('channel-1');
    const assertion = expect(done).rejects.toThrow(WahaThrottleError);
    await vi.runAllTimersAsync();
    await assertion;
  });
});
