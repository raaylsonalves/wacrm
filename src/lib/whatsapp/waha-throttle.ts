/**
 * Anti-ban send throttle for WAHA channels
 * (specs/waha-anti-banimento-e-opt-out.md). Every caller of
 * `sendWahaText` must claim a slot here first — WAHA is an unofficial
 * WhatsApp connection, and a burst of messages with no spacing is the
 * single most common cause of an unexplained ban.
 *
 * The claim is a DB-atomic RPC (`claim_waha_send_slot`, migration
 * 064), not an in-memory counter — the app runs serverless (Vercel),
 * so a process-local counter can't coordinate two concurrent
 * invocations sending on the same WAHA session (see the trade-off
 * `src/lib/rate-limit.ts` documents for its own, different, use case).
 */

import { supabaseAdmin } from '@/lib/flows/admin-client';

/** Minimum spacing between two 1-on-1 sends on the same session. */
const INTERVAL_MS_ONE_TO_ONE = 1200;
/** Minimum spacing between two broadcast sends on the same session —
 *  more conservative because it's a deliberate burst by design. */
const INTERVAL_MS_BROADCAST = 5000;
/** Random delay added before every claim attempt so spacing doesn't
 *  look programmatic. */
const JITTER_MAX_MS = 800;
/** A session younger than this uses double the normal interval — a
 *  brand-new number draws more suspicion from WhatsApp at volume. */
const WARMUP_DAYS = 14;
const WARMUP_MULTIPLIER = 2;
/** Wait between failed claim attempts, and the hard ceiling on how
 *  long we'll keep retrying before giving up loudly instead of
 *  silently dropping the send. */
const RETRY_DELAY_MS = 300;
const MAX_WAIT_MS = 10_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class WahaThrottleError extends Error {
  constructor() {
    super('Could not get a WAHA send slot in time — try again shortly.');
    this.name = 'WahaThrottleError';
  }
}

/**
 * Blocks until this WAHA channel is clear to send, or throws
 * `WahaThrottleError` after `MAX_WAIT_MS` of retrying — callers must
 * not swallow that and send anyway; the whole point is that an
 * un-throttled send never reaches WAHA.
 */
export async function claimWahaSendSlot(
  channelId: string,
  opts: { isBroadcast?: boolean; connectedAt?: string | null } = {}
): Promise<void> {
  const base = opts.isBroadcast
    ? INTERVAL_MS_BROADCAST
    : INTERVAL_MS_ONE_TO_ONE;
  const isWarmingUp =
    !!opts.connectedAt &&
    Date.now() - new Date(opts.connectedAt).getTime() <
      WARMUP_DAYS * 24 * 60 * 60 * 1000;
  const minIntervalMs = isWarmingUp ? base * WARMUP_MULTIPLIER : base;

  await sleep(Math.random() * JITTER_MAX_MS);

  const deadline = Date.now() + MAX_WAIT_MS;
  for (;;) {
    const { data: claimed, error } = await supabaseAdmin().rpc(
      'claim_waha_send_slot',
      { channel_id: channelId, min_interval_ms: minIntervalMs }
    );
    if (error) {
      console.error('[waha-throttle] claim RPC failed:', error.message);
      throw new WahaThrottleError();
    }
    if (claimed) return;
    if (Date.now() >= deadline) throw new WahaThrottleError();
    await sleep(RETRY_DELAY_MS);
  }
}
