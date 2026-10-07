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
// `exempt` accounts are never touched.

import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  MercadoPagoError,
  createPixOrder,
  extractPixPayment,
} from './mercadopago';
import { isFullyPaid } from './transitions';

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
}

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
    const grace = sub.grace_until ? new Date(sub.grace_until).getTime() : null;
    return grace !== null && grace < t ? 'lapse' : null;
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
    .maybeSingle();
  if (existing) return false;

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

  const externalReference = randomUUID();
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
      randomUUID()
    );
  } catch (err) {
    if (err instanceof MercadoPagoError) {
      console.error('[billing/sweep] Pix renewal rejected', err.message);
      return false;
    }
    throw err;
  }
  const pix = extractPixPayment(order);
  const { error } = await db.from('billing_pix_orders').insert({
    account_id: sub.account_id,
    external_reference: externalReference,
    mp_order_id: order.id,
    amount_cents: sub.amount_cents,
    period_start: period,
    status: 'pending',
    qr_code: pix.qrCode,
    qr_code_base64: pix.qrCodeBase64,
    ticket_url: pix.ticketUrl,
    expires_at: new Date(now.getTime() + 7 * 86_400_000).toISOString(),
  });
  // A concurrent sweep may have inserted it first; that is fine.
  if (error && error.code !== '23505') throw error;
  return !error;
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
  const { data: subs, error } = await db
    .from('billing_subscriptions')
    .select(
      'id, account_id, method, status, amount_cents, charges_paid, charges_total, current_period_end, grace_until'
    )
    .in('status', ['active', 'past_due', 'canceled']);
  if (error) throw error;

  for (const sub of (subs ?? []) as SweepSubscription[]) {
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
        await db
          .from('billing_subscriptions')
          .update({
            status: 'past_due',
            grace_until: new Date(now.getTime() + GRACE_MS).toISOString(),
          })
          .eq('id', sub.id);
        await setAccountStatus(db, sub.account_id, 'past_due');
        summary.toPastDue++;
      } else if (action === 'lapse') {
        await db
          .from('billing_subscriptions')
          .update({ status: 'canceled', canceled_at: now.toISOString() })
          .eq('id', sub.id);
        await setAccountStatus(db, sub.account_id, 'canceled');
        summary.lapsed++;
      } else if (action === 'close_canceled') {
        await setAccountStatus(db, sub.account_id, 'canceled');
        summary.closed++;
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
