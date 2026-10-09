// Time-driven billing: things that happen because a date passed, not
// because Mercado Pago sent a notification. Run from the automations cron
// hub (GET /api/automations/cron). `classifySubscription` is the pure rule
// set (unit-tested); `runBillingSweep` applies it with the service role.
//
//   Pix is a charge per month, so nothing renews it by itself:
//     - 3 days before the paid period ends, the next month's Pix is created;
//     - if the period ends unpaid -> past_due with a 3-day grace (the
//       renewal Pix exists from 3 days before, so ~6 days to pay in all);
//     - grace over and still unpaid -> canceled (access blocked).
//   A subscription the customer cancelled keeps access to the end of the
//   period it paid for; only then is the account closed.
//
//   A subscription stuck in `pending` (a card checkout that failed, an
//   operator extension) while the account is usable is closed once its
//   period is over, so it can never mean free access forever.
//
// Every write is conditional on the state it was classified from, and
// every notice goes through notifyBilling's dedupe, so two overlapping
// cron runs do the work (and send the notice) once.
//
// `exempt` accounts are never touched.

import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  MercadoPagoError,
  cancelPreapproval,
  createPixOrder,
  extractPixPayment,
} from './mercadopago';
import { fetchAllRows } from '@/lib/supabase/paginate';
import { isFullyPaid } from './transitions';
import { notifyBilling } from './notify';

export const RENEW_BEFORE_MS = 3 * 86_400_000;
export const GRACE_MS = 3 * 86_400_000;

export interface SweepSubscription {
  id: string;
  account_id: string;
  method: 'pix' | 'card';
  status: 'pending' | 'active' | 'past_due' | 'canceled';
  amount_cents: number;
  charges_paid: number;
  charges_total: number | null;
  current_period_end: string | null;
  grace_until: string | null;
  mp_preapproval_id?: string | null;
  updated_at?: string | null;
}

/** A pending row younger than this may still be a checkout in flight. */
export const STALE_PENDING_MS = 86_400_000;
/** How long after the period a resumed card plan may wait for its first
 *  charge (Mercado Pago retries a declined one for ~10 days). */
export const CARD_FIRST_CHARGE_MS = 12 * 86_400_000;

export type SweepAction =
  'to_past_due' | 'lapse' | 'close_canceled' | 'renew_pix' | null;

export function classifySubscription(
  sub: SweepSubscription,
  accountStatus: string,
  now: Date
): SweepAction {
  if (accountStatus === 'exempt') return null;
  const end = sub.current_period_end ? new Date(sub.current_period_end) : null;
  const t = now.getTime();

  if (sub.status === 'canceled') {
    // Cancelled by the customer (or a finished annual plan): access runs to
    // the end of the paid period, then the account closes.
    return end && end.getTime() < t && accountStatus !== 'canceled'
      ? 'close_canceled'
      : null;
  }
  if (sub.status === 'past_due') {
    // No grace date at all is not "forever": treat it as already over.
    const grace = sub.grace_until ? new Date(sub.grace_until).getTime() : 0;
    return grace < t ? 'lapse' : null;
  }
  if (sub.status === 'pending') {
    // Nothing will ever charge this row (no live card subscription), yet
    // the account is usable: close it once its period, if any, is over.
    const usable = accountStatus === 'active' || accountStatus === 'past_due';
    const touched = sub.updated_at ? new Date(sub.updated_at).getTime() : 0;
    const periodOver = !end || end.getTime() < t;
    if (!usable || !periodOver || t - touched <= STALE_PENDING_MS) return null;
    // A card subscription exists but its first charge never landed long
    // after the period ended (Mercado Pago retries for ~10 days): close
    // it instead of leaving access open while it stays paused.
    if (sub.mp_preapproval_id) {
      return end && t - end.getTime() > CARD_FIRST_CHARGE_MS ? 'lapse' : null;
    }
    return 'lapse';
  }
  if (sub.status === 'active' && sub.method === 'pix' && end) {
    if (end.getTime() < t) return 'to_past_due';
    if (
      end.getTime() - t <= RENEW_BEFORE_MS &&
      !isFullyPaid(sub.charges_paid, sub.charges_total)
    ) {
      return 'renew_pix';
    }
  }
  return null;
}

/** First day (UTC) of the month `d` falls in, as YYYY-MM-DD. */
export function monthStartOf(d: Date): string {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1))
    .toISOString()
    .slice(0, 10);
}

async function setAccountStatus(
  db: SupabaseClient,
  accountId: string,
  status: 'active' | 'past_due' | 'canceled'
) {
  const { error } = await db
    .from('accounts')
    .update({ subscription_status: status })
    .eq('id', accountId)
    .neq('subscription_status', 'exempt');
  if (error) throw error;
}

async function renewPix(
  db: SupabaseClient,
  sub: SweepSubscription,
  now: Date
): Promise<boolean> {
  const end = new Date(sub.current_period_end as string);
  const period = monthStartOf(end);
  const { data: existing } = await db
    .from('billing_pix_orders')
    .select('id')
    .eq('account_id', sub.account_id)
    .eq('period_start', period)
    .in('status', ['pending', 'paid'])
    .limit(1);
  if (existing && existing.length > 0) return false;

  const { data: account } = await db
    .from('accounts')
    .select('owner_user_id')
    .eq('id', sub.account_id)
    .maybeSingle();
  const ownerId = account?.owner_user_id as string | undefined;
  if (!ownerId) return false;
  const { data: owner } = await db.auth.admin.getUserById(ownerId);
  const email = owner.user?.email;
  if (!email) return false;

  // Claim first: the partial unique index (one PENDING order per account
  // and period, migration 122) makes a concurrent sweep lose HERE, before
  // it creates an order at Mercado Pago that nothing would ever track.
  const externalReference = randomUUID();
  const { data: claimed, error: claimErr } = await db
    .from('billing_pix_orders')
    .insert({
      account_id: sub.account_id,
      external_reference: externalReference,
      amount_cents: sub.amount_cents,
      period_start: period,
      status: 'pending',
      expires_at: new Date(now.getTime() + 7 * 86_400_000).toISOString(),
    })
    .select('id')
    .single();
  if (claimErr) {
    if (claimErr.code === '23505') return false;
    throw claimErr;
  }

  let order;
  try {
    order = await createPixOrder(
      {
        externalReference,
        amountCents: sub.amount_cents,
        payerEmail: email,
        // Payable until a few days after the period ends, within the grace.
        expiresIn: 'P7D',
      },
      // Same key on a retry of this claim: never two orders for one row.
      claimed.id as string
    );
  } catch (err) {
    // Release the claim so the next run tries again.
    await db.from('billing_pix_orders').delete().eq('id', claimed.id);
    if (err instanceof MercadoPagoError) {
      console.error('[billing/sweep] Pix renewal rejected', err.message);
      return false;
    }
    throw err;
  }
  const pix = extractPixPayment(order);
  const { error } = await db
    .from('billing_pix_orders')
    .update({
      mp_order_id: order.id,
      qr_code: pix.qrCode,
      qr_code_base64: pix.qrCodeBase64,
      ticket_url: pix.ticketUrl,
    })
    .eq('id', claimed.id);
  if (error) throw error;
  await notifyBilling(
    db,
    sub.account_id,
    {
      kind: 'pix_due',
      amountCents: sub.amount_cents,
      dueAt: end,
      ticketUrl: pix.ticketUrl ?? null,
    },
    `pix_due:${period}`
  );
  return true;
}

/** Moves a subscription out of `from` only if it is still in `from`. */
async function transition(
  db: SupabaseClient,
  sub: SweepSubscription,
  patch: Record<string, unknown>
): Promise<boolean> {
  const { data, error } = await db
    .from('billing_subscriptions')
    .update(patch)
    .eq('id', sub.id)
    .eq('status', sub.status)
    .select('id');
  if (error) throw error;
  return !!data && data.length > 0;
}

export interface SweepSummary {
  checked: number;
  toPastDue: number;
  lapsed: number;
  closed: number;
  renewed: number;
}

export async function runBillingSweep(
  db: SupabaseClient,
  now = new Date()
): Promise<SweepSummary> {
  const summary: SweepSummary = {
    checked: 0,
    toPastDue: 0,
    lapsed: 0,
    closed: 0,
    renewed: 0,
  };
  // Paginated (PostgREST caps a response at 1000 rows). A cancelled row
  // whose account is already closed has nothing left to do and is not
  // worth reading every tick, but the account status lives in another
  // table, so it is filtered below.
  const subs = await fetchAllRows<SweepSubscription>((from, to) =>
    db
      .from('billing_subscriptions')
      .select(
        'id, account_id, method, status, amount_cents, charges_paid, charges_total, current_period_end, grace_until, mp_preapproval_id, updated_at'
      )
      .in('status', ['pending', 'active', 'past_due', 'canceled'])
      .order('id')
      .range(from, to)
  );

  for (const sub of subs) {
    summary.checked++;
    const { data: account } = await db
      .from('accounts')
      .select('subscription_status')
      .eq('id', sub.account_id)
      .maybeSingle();
    const action = classifySubscription(
      sub,
      String(account?.subscription_status ?? ''),
      now
    );
    try {
      if (action === 'to_past_due') {
        const graceUntil = new Date(now.getTime() + GRACE_MS);
        if (
          await transition(db, sub, {
            status: 'past_due',
            grace_until: graceUntil.toISOString(),
          })
        ) {
          await setAccountStatus(db, sub.account_id, 'past_due');
          summary.toPastDue++;
          await notifyBilling(
            db,
            sub.account_id,
            { kind: 'past_due', amountCents: sub.amount_cents, graceUntil },
            `past_due:${sub.current_period_end ?? ''}`
          );
        }
      } else if (action === 'lapse') {
        if (
          await transition(db, sub, {
            status: 'canceled',
            canceled_at: now.toISOString(),
          })
        ) {
          await setAccountStatus(db, sub.account_id, 'canceled');
          summary.lapsed++;
          // A card whose grace ran out must stop charging too, or a later
          // retry (or a new subscription on top) charges twice.
          if (sub.method === 'card' && sub.mp_preapproval_id) {
            await cancelPreapproval(sub.mp_preapproval_id).catch((err) =>
              console.error('[billing/sweep] could not cancel preapproval', err)
            );
          }
          await notifyBilling(db, sub.account_id, { kind: 'ended' }, `ended:${sub.id}:${sub.current_period_end ?? sub.updated_at ?? now.toISOString()}`);
        }
      } else if (action === 'close_canceled') {
        await setAccountStatus(db, sub.account_id, 'canceled');
        summary.closed++;
        await notifyBilling(db, sub.account_id, { kind: 'ended' }, `ended:${sub.id}:${sub.current_period_end ?? sub.updated_at ?? now.toISOString()}`);
      } else if (action === 'renew_pix') {
        if (await renewPix(db, sub, now)) summary.renewed++;
      }
    } catch (err) {
      // One account's failure must not stop the rest of the sweep.
      console.error('[billing/sweep] failed for a subscription', err);
    }
  }
  return summary;
}
