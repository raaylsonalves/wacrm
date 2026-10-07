// Applies a verified Mercado Pago notification to our own tables. Called by
// the webhook with the service-role client, so tenancy is OURS to enforce:
// the account is only ever resolved from our own billing rows (matched by
// the Mercado Pago ids / the external_reference WE generated), never from
// anything in the notification or the browser.

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  MercadoPagoError,
  getAuthorizedPayment,
  getOrder,
  getPreapproval,
} from './mercadopago';
import {
  chargeOutcome,
  isFullyPaid,
  nextPeriodEnd,
  pixOrderStatus,
  subscriptionStatusFromPreapproval,
  toCents,
} from './transitions';
import type { BillingSource } from './webhook-signature';

export type ApplyResult =
  | 'applied'
  | 'ignored_topic'
  | 'unknown_resource'
  | 'amount_mismatch'
  | 'already_applied';

/** Never overwrite `exempt`: operator-released accounts stay released. */
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

/** Records one paid charge once. The synthetic event row is the lock: a
 *  second notification about the same charge hits the unique constraint. */
async function claimCharge(
  db: SupabaseClient,
  source: BillingSource,
  key: string
): Promise<boolean> {
  const { error } = await db.from('billing_events').insert({
    source,
    event_id: `charge:${key}`,
    topic: 'charge',
    raw: {},
    processed_at: new Date().toISOString(),
  });
  if (!error) return true;
  if (error.code === '23505') return false;
  throw error;
}

interface PaymentFact {
  method: 'pix' | 'card';
  amountCents: number;
  /** Mercado Pago order id (Pix) or authorized payment id (card). */
  providerRef: string;
}

async function registerPaidCharge(
  db: SupabaseClient,
  accountId: string,
  paidAt: Date,
  payment: PaymentFact
) {
  // The payment history (Settings > Billing, subscribers panel). Unique
  // per provider reference, so a redelivery cannot record it twice.
  const { error: payErr } = await db.from('billing_payments').upsert(
    {
      account_id: accountId,
      method: payment.method,
      amount_cents: payment.amountCents,
      provider_ref: payment.providerRef,
      paid_at: paidAt.toISOString(),
    },
    { onConflict: 'method,provider_ref', ignoreDuplicates: true }
  );
  if (payErr) throw payErr;
  const { data: sub, error } = await db
    .from('billing_subscriptions')
    .select('id, charges_paid, charges_total, current_period_end')
    .eq('account_id', accountId)
    .maybeSingle();
  if (error) throw error;
  if (!sub) return;
  const charges = (sub.charges_paid as number) + 1;
  const end = nextPeriodEnd(
    sub.current_period_end ? new Date(sub.current_period_end as string) : null,
    paidAt
  );
  const done = isFullyPaid(charges, sub.charges_total as number | null);
  const { error: upErr } = await db
    .from('billing_subscriptions')
    .update({
      charges_paid: charges,
      current_period_end: end.toISOString(),
      status: done ? 'canceled' : 'active',
      grace_until: null,
    })
    .eq('id', sub.id);
  if (upErr) throw upErr;
  // A finished annual plan simply stops: access runs to the period end.
  await setAccountStatus(db, accountId, 'active');
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface SubRow {
  id: string;
  account_id: string;
  amount_cents: number;
}

/**
 * The subscription a preapproval belongs to. The preapproval id is stored
 * right AFTER Mercado Pago creates it, so a notification can arrive in the
 * gap: fall back to the external_reference we sent (our own row id) and
 * adopt the id then. Only a row that has no preapproval yet is adopted, so
 * a notification can never re-point someone else's subscription.
 */
async function findSubscription(
  db: SupabaseClient,
  preapprovalId: string,
  externalReference: string | undefined
): Promise<SubRow | null> {
  const { data, error } = await db
    .from('billing_subscriptions')
    .select('id, account_id, amount_cents')
    .eq('mp_preapproval_id', preapprovalId)
    .maybeSingle();
  if (error) throw error;
  if (data) return data as SubRow;
  if (!externalReference || !UUID.test(externalReference)) return null;
  const { data: adopted, error: adoptErr } = await db
    .from('billing_subscriptions')
    .update({ mp_preapproval_id: preapprovalId })
    .eq('id', externalReference)
    .is('mp_preapproval_id', null)
    .select('id, account_id, amount_cents')
    .maybeSingle();
  if (adoptErr) throw adoptErr;
  return (adopted as SubRow | null) ?? null;
}

async function applyOrder(
  db: SupabaseClient,
  dataId: string
): Promise<ApplyResult> {
  const order = await getOrder(dataId);
  const ref = order.external_reference;
  if (!ref) return 'unknown_resource';
  const { data: row, error } = await db
    .from('billing_pix_orders')
    .select('id, account_id, status, amount_cents, mp_order_id')
    .eq('external_reference', ref)
    .maybeSingle();
  if (error) throw error;
  if (!row) return 'unknown_resource';
  if (row.status === 'paid') return 'already_applied';
  // The order we created for this reference is the only one that counts.
  if (row.mp_order_id && row.mp_order_id !== order.id) {
    console.error('[billing] order id does not match our reference', { ref });
    return 'unknown_resource';
  }

  const status = pixOrderStatus(order.status);
  if (status === 'paid' && toCents(order.total_amount) !== row.amount_cents) {
    console.error('[billing] Pix order amount mismatch', { ref });
    return 'amount_mismatch';
  }

  // Conditional update: only the first notification flips pending -> paid.
  const patch: Record<string, unknown> = { status, mp_order_id: order.id };
  if (status === 'paid') patch.paid_at = new Date().toISOString();
  const { data: changed, error: upErr } = await db
    .from('billing_pix_orders')
    .update(patch)
    .eq('id', row.id)
    .neq('status', 'paid')
    .select('id');
  if (upErr) throw upErr;
  if (status === 'paid' && changed && changed.length > 0) {
    await registerPaidCharge(db, row.account_id as string, new Date(), {
      method: 'pix',
      amountCents: row.amount_cents as number,
      providerRef: String(order.id),
    });
  }
  return 'applied';
}

async function applyPreapproval(
  db: SupabaseClient,
  dataId: string
): Promise<ApplyResult> {
  const pre = await getPreapproval(dataId);
  const sub = await findSubscription(db, pre.id, pre.external_reference);
  if (!sub) return 'unknown_resource';

  const status = subscriptionStatusFromPreapproval(pre.status);
  const amount = toCents(pre.auto_recurring?.transaction_amount);
  if (status === 'active' && amount !== sub.amount_cents) {
    console.error('[billing] preapproval amount mismatch', { id: sub.id });
    return 'amount_mismatch';
  }
  const patch: Record<string, unknown> = { status };
  if (status === 'canceled') patch.canceled_at = new Date().toISOString();
  // The first card charge can land before (or without) its payment
  // notification, which is what normally sets the period end. Seed it from
  // the preapproval so "next charge" is never blank on an active plan.
  if (status === 'active' && pre.next_payment_date) {
    const { data: cur } = await db
      .from('billing_subscriptions')
      .select('current_period_end')
      .eq('id', sub.id)
      .maybeSingle();
    if (!cur?.current_period_end) {
      patch.current_period_end = new Date(pre.next_payment_date).toISOString();
    }
  }
  const { error: upErr } = await db
    .from('billing_subscriptions')
    .update(patch)
    .eq('id', sub.id);
  if (upErr) throw upErr;
  if (status === 'canceled') {
    // Cancelled: access runs to the end of the period already paid, then
    // the sweep closes the account. Close it now only if there is none.
    const { data: paid } = await db
      .from('billing_subscriptions')
      .select('current_period_end')
      .eq('id', sub.id)
      .maybeSingle();
    const end = paid?.current_period_end
      ? new Date(paid.current_period_end as string)
      : null;
    if (!end || end.getTime() <= Date.now()) {
      await setAccountStatus(db, sub.account_id, 'canceled');
    }
  } else if (status !== 'pending') {
    await setAccountStatus(db, sub.account_id, status);
  }
  return 'applied';
}

async function applyAuthorizedPayment(
  db: SupabaseClient,
  dataId: string
): Promise<ApplyResult> {
  const ap = await getAuthorizedPayment(dataId);
  if (!ap.preapproval_id) return 'unknown_resource';
  let sub = await findSubscription(db, ap.preapproval_id, undefined);
  if (!sub) {
    // Not stored yet: ask Mercado Pago whose subscription this is.
    const pre = await getPreapproval(ap.preapproval_id);
    sub = await findSubscription(db, pre.id, pre.external_reference);
  }
  if (!sub) return 'unknown_resource';

  const outcome = chargeOutcome(ap.status);
  if (outcome === 'paid') {
    if (toCents(ap.transaction_amount) !== sub.amount_cents) {
      console.error('[billing] charge amount mismatch', { id: sub.id });
      return 'amount_mismatch';
    }
    if (!(await claimCharge(db, 'subs', String(ap.id)))) {
      return 'already_applied';
    }
    await registerPaidCharge(db, sub.account_id as string, new Date(), {
      method: 'card',
      amountCents: sub.amount_cents,
      providerRef: String(ap.id),
    });
    return 'applied';
  }
  if (outcome === 'retrying' || outcome === 'failed') {
    // Mercado Pago retries a declined charge up to 4 times in 10 days:
    // past_due now, with a grace window the app can enforce later.
    const grace = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const { error: upErr } = await db
      .from('billing_subscriptions')
      .update({ status: 'past_due', grace_until: grace })
      .eq('id', sub.id)
      .neq('status', 'canceled');
    if (upErr) throw upErr;
    await setAccountStatus(db, sub.account_id as string, 'past_due');
    return 'applied';
  }
  return 'ignored_topic';
}

export async function applyNotification(
  db: SupabaseClient,
  source: BillingSource,
  topic: string,
  dataId: string
): Promise<ApplyResult> {
  try {
    return await dispatch(db, source, topic, dataId);
  } catch (err) {
    // Mercado Pago says this id does not exist / is malformed: retrying
    // can never fix it, so acknowledge instead of asking for redelivery.
    if (
      err instanceof MercadoPagoError &&
      (err.status === 400 || err.status === 404)
    ) {
      return 'unknown_resource';
    }
    throw err;
  }
}

async function dispatch(
  db: SupabaseClient,
  source: BillingSource,
  topic: string,
  dataId: string
): Promise<ApplyResult> {
  if (source === 'pix' && topic === 'order') return applyOrder(db, dataId);
  if (source === 'subs' && topic === 'subscription_preapproval') {
    return applyPreapproval(db, dataId);
  }
  if (source === 'subs' && topic === 'subscription_authorized_payment') {
    return applyAuthorizedPayment(db, dataId);
  }
  return 'ignored_topic';
}
