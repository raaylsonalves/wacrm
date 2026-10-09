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
  pixOrderStatus,
  subscriptionStatusFromPreapproval,
  toCents,
} from './transitions';
import type { BillingSource } from './webhook-signature';
import { notifyBilling } from './notify';

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

interface PaymentFact {
  method: 'pix' | 'card';
  amountCents: number;
  /** Mercado Pago order id (Pix) or authorized payment id (card). */
  providerRef: string;
}

/**
 * Records one confirmed payment and applies it to the subscription and the
 * account in one transaction (migration 122). Idempotent on the payment
 * row: a redelivered notification, or one retried after a failure halfway,
 * either applies it now or finds it already applied — a confirmed payment
 * can no longer be lost between two writes. Returns whether THIS call
 * recorded it (and so owns the notice).
 */
async function registerPaidCharge(
  db: SupabaseClient,
  accountId: string,
  paidAt: Date,
  payment: PaymentFact
): Promise<boolean> {
  const { data, error } = await db.rpc('billing_register_payment', {
    p_account_id: accountId,
    p_method: payment.method,
    p_amount_cents: payment.amountCents,
    p_provider_ref: payment.providerRef,
    p_paid_at: paidAt.toISOString(),
  });
  if (error) throw error;
  const r = (data ?? {}) as {
    inserted?: boolean;
    subscription?: boolean;
    period_end?: string;
    done?: boolean;
  };
  if (!r.inserted) return false;
  if (r.subscription) {
    await notifyBilling(
      db,
      accountId,
      {
        kind: 'paid',
        amountCents: payment.amountCents,
        method: payment.method,
        periodEnd: r.period_end ? new Date(r.period_end) : null,
        finished: !!r.done,
      },
      `paid:${payment.method}:${payment.providerRef}`
    );
  }
  return true;
}

/** Card grace (Terms: up to 7 days while Mercado Pago retries). */
const CARD_GRACE_MS = 7 * 86_400_000;

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
 * adopt the id then. Only a card row still waiting for its preapproval is
 * adopted: a row switched to Pix also has no preapproval id, and a late
 * notification about its OLD (cancelled) card subscription, which carries
 * the same external_reference, must not take it over.
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
    .eq('method', 'card')
    .eq('status', 'pending')
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

  // A paid order never goes back. A replaced (cancelled) order that is
  // paid anyway is real money: it is recorded and credited like any other.
  // Only payment moves it on: a late "still open" about a replaced order
  // must not reopen it (QA of review 2026-10).
  if (row.status !== 'paid' && (row.status !== 'canceled' || status === 'paid')) {
    const patch: Record<string, unknown> = { status, mp_order_id: order.id };
    if (status === 'paid') patch.paid_at = new Date().toISOString();
    const { error: upErr } = await db
      .from('billing_pix_orders')
      .update(patch)
      .eq('id', row.id)
      .neq('status', 'paid');
    if (upErr) throw upErr;
  }
  if (status !== 'paid') return 'applied';
  // Idempotent: the payment row decides whether this was already applied,
  // so a redelivery after a failure halfway still credits it.
  const recorded = await registerPaidCharge(
    db,
    row.account_id as string,
    new Date(),
    {
      method: 'pix',
      amountCents: row.amount_cents as number,
      providerRef: String(order.id),
    }
  );
  return recorded ? 'applied' : 'already_applied';
}

async function applyPreapproval(
  db: SupabaseClient,
  dataId: string
): Promise<ApplyResult> {
  const pre = await getPreapproval(dataId);
  const sub = await findSubscription(db, pre.id, pre.external_reference);
  if (!sub) return 'unknown_resource';

  const status = subscriptionStatusFromPreapproval(pre.status);
  if (status === null) {
    // A status we do not model: changing nothing is safer than guessing.
    console.warn('[billing] unhandled preapproval status', pre.status);
    return 'ignored_topic';
  }
  const amount = toCents(pre.auto_recurring?.transaction_amount);
  if (status === 'active' && amount !== sub.amount_cents) {
    console.error('[billing] preapproval amount mismatch', { id: sub.id });
    return 'amount_mismatch';
  }
  const { data: cur, error: curErr } = await db
    .from('billing_subscriptions')
    .select('status, current_period_end')
    .eq('id', sub.id)
    .maybeSingle();
  if (curErr) throw curErr;
  const current = (cur?.status as string | undefined) ?? 'pending';
  // Not authorised yet at Mercado Pago: nothing to change.
  if (status === 'pending') return 'applied';

  if (status === 'active') {
    // Authorised is not paid: only a processed charge (registerPaidCharge)
    // activates a subscription. This also keeps a card swap during
    // past_due from re-opening access before the new card is charged.
    // Seed the next charge date so the screen is not blank meanwhile.
    if (!cur?.current_period_end && pre.next_payment_date) {
      const { error: upErr } = await db
        .from('billing_subscriptions')
        .update({
          current_period_end: new Date(pre.next_payment_date).toISOString(),
        })
        .eq('id', sub.id);
      if (upErr) throw upErr;
    }
    return 'applied';
  }

  if (status === 'past_due') {
    // Paused by Mercado Pago after failed charges. Grace starts once.
    if (current === 'active') {
      await enterCardGrace(db, sub, null);
    }
    return 'applied';
  }

  // Cancelled at Mercado Pago (by the customer, us, or the end of retries).
  const { error: upErr } = await db
    .from('billing_subscriptions')
    .update({ status: 'canceled', canceled_at: new Date().toISOString() })
    .eq('id', sub.id)
    .neq('status', 'canceled');
  if (upErr) throw upErr;
  // Access runs to the end of the period already paid, then the sweep
  // closes the account. Close it now only if there is none.
  const end = cur?.current_period_end
    ? new Date(cur.current_period_end as string)
    : null;
  if (!end || end.getTime() <= Date.now()) {
    await setAccountStatus(db, sub.account_id, 'canceled');
  }
  return 'applied';
}

/**
 * A card charge failed on an active subscription: past_due with a grace
 * window that starts ONCE — Mercado Pago's retries notify again, and
 * re-arming the window each time stretched the 7 days of the Terms to ~17.
 */
async function enterCardGrace(
  db: SupabaseClient,
  sub: SubRow,
  chargeRef: string | null
) {
  // A plan resumed inside a paid period is `pending` until its first charge
  // while the account keeps its access: when that charge fails it must
  // enter grace like an active one, or access stayed open with nothing
  // paying for it (QA of review 2026-10).
  const { data: acc } = await db
    .from('accounts')
    .select('subscription_status')
    .eq('id', sub.account_id)
    .maybeSingle();
  const from =
    acc?.subscription_status === 'active' ? ['active', 'pending'] : ['active'];
  const grace = new Date(Date.now() + CARD_GRACE_MS);
  const { data: changed, error } = await db
    .from('billing_subscriptions')
    .update({ status: 'past_due', grace_until: grace.toISOString() })
    .eq('id', sub.id)
    .in('status', from)
    .select('id');
  if (error) throw error;
  if (!changed || changed.length === 0) return;
  await setAccountStatus(db, sub.account_id, 'past_due');
  await notifyBilling(
    db,
    sub.account_id,
    {
      kind: 'card_declined',
      amountCents: sub.amount_cents,
      graceUntil: grace,
    },
    `declined:${chargeRef ?? grace.toISOString().slice(0, 10)}`
  );
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
    const recorded = await registerPaidCharge(
      db,
      sub.account_id as string,
      new Date(),
      {
        method: 'card',
        amountCents: sub.amount_cents,
        providerRef: String(ap.id),
      }
    );
    return recorded ? 'applied' : 'already_applied';
  }
  if (outcome === 'retrying' || outcome === 'failed') {
    // Mercado Pago retries a declined charge up to 4 times in 10 days. Only
    // a subscription with access to keep enters grace (active, or a resumed
    // plan on a still-active account); a brand-new one never had access,
    // and past_due already has its window running.
    await enterCardGrace(db, sub, String(ap.id));
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
