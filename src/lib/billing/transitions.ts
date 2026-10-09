// Pure rules that turn what Mercado Pago reports into our own state. The
// webhook never trusts the notification body: it re-reads the resource from
// the Mercado Pago API and passes THAT here, so the result is always the
// current truth and an out-of-order notification cannot roll state back.

import type { SubscriptionStatus } from './status';

/** "197.00" / 197 -> 19700. Returns null for anything that is not money. */
export function toCents(value: unknown): number | null {
  const n =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d+(\.\d{1,2})?$/.test(value.trim())
        ? Number(value)
        : NaN;
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

export type PixOrderStatus =
  'pending' | 'paid' | 'expired' | 'canceled' | 'failed';

/**
 * Orders API status -> our Pix order status. `processed` is the paid
 * state; `action_required` is an open Pix still waiting for the payer.
 * Anything unknown stays `pending`, never paid.
 */
export function pixOrderStatus(orderStatus: unknown): PixOrderStatus {
  switch (orderStatus) {
    case 'processed':
      return 'paid';
    case 'expired':
      return 'expired';
    case 'canceled':
    case 'cancelled':
      return 'canceled';
    case 'failed':
      return 'failed';
    default:
      return 'pending';
  }
}

export type SubStatus = 'pending' | 'active' | 'past_due' | 'canceled';

/**
 * Preapproval (card subscription) status -> our subscription status.
 * `pending` is Mercado Pago's own "not authorised yet"; anything else we
 * do not model returns null and the caller changes nothing (it used to
 * downgrade an active subscription to pending).
 */
export function subscriptionStatusFromPreapproval(mp: unknown): SubStatus | null {
  switch (mp) {
    case 'authorized':
      return 'active';
    case 'paused':
      return 'past_due';
    case 'cancelled':
    case 'canceled':
      return 'canceled';
    case 'pending':
      return 'pending';
    default:
      return null;
  }
}

/** One monthly charge of a card subscription: processed = paid. */
export function chargeOutcome(
  status: unknown
): 'paid' | 'retrying' | 'failed' | 'pending' {
  switch (status) {
    case 'processed':
      return 'paid';
    case 'recycling':
      return 'retrying';
    case 'cancelled':
    case 'canceled':
    case 'rejected':
      return 'failed';
    default:
      return 'pending';
  }
}

/** The account status that follows a subscription status. */
export function accountStatusFor(sub: SubStatus): SubscriptionStatus {
  return sub;
}

/** End of the paid month: one calendar month after `from`, clamped to the
 *  last day of a shorter month (31 Jan + 1 month = 28/29 Feb). */
export function addOneMonth(from: Date): Date {
  const d = new Date(from.getTime());
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + 1);
  const last = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)
  ).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d;
}

/**
 * Where the paid period ends after one more paid charge. A charge paid
 * while the previous period is still running extends it; a late payment
 * starts a fresh month from now.
 */
export function nextPeriodEnd(currentEnd: Date | null, paidAt: Date): Date {
  const base = currentEnd && currentEnd > paidAt ? currentEnd : paidAt;
  return addOneMonth(base);
}

/** True once an annual plan has taken all of its monthly charges. */
export function isFullyPaid(
  chargesPaid: number,
  chargesTotal: number | null
): boolean {
  return chargesTotal !== null && chargesPaid >= chargesTotal;
}
