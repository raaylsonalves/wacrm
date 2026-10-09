// ============================================================
// POST /api/billing/checkout/card — start a card subscription.
//
// The browser tokenises the card with Mercado Pago's own form and sends
// only { plan, cycle, cardToken }. The price is computed HERE from
// lib/billing/plans (never taken from the client), the subscription row
// is created pending, and Mercado Pago creates the recurring charge from
// the token. Nothing is activated by this route: only the verified
// webhook moves the account to `active`.
// ============================================================

import { createHash, randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { canManageBilling } from '@/lib/auth/roles';
import { supabaseAdmin } from '@/lib/ai/admin-client';
import {
  MercadoPagoError,
  cancelOrder,
  cancelPreapproval,
  createPreapproval,
} from '@/lib/billing/mercadopago';
import {
  isBillingCycle,
  isPlanId,
  quoteSubscription,
} from '@/lib/billing/plans';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const LIMIT = { limit: 10, windowMs: 10 * 60_000 };
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('owner', { allowUnpaid: true });
    if (!canManageBilling(ctx.role)) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 });
    }
    const limit = checkRateLimit(`billing:checkout:${ctx.userId}`, LIMIT);
    if (!limit.success) return rateLimitResponse(limit);

    const body = (await request.json().catch(() => null)) as {
      plan?: unknown;
      cycle?: unknown;
      cardToken?: unknown;
      payerEmail?: unknown;
    } | null;
    const { plan, cycle, cardToken } = body ?? {};
    if (
      !isPlanId(plan) ||
      !isBillingCycle(cycle) ||
      typeof cardToken !== 'string' ||
      cardToken.length < 8 ||
      cardToken.length > 200
    ) {
      return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
    }

    const { data: userData } = await ctx.supabase.auth.getUser();
    const payerEmail =
      typeof body?.payerEmail === 'string' && EMAIL.test(body.payerEmail)
        ? body.payerEmail
        : userData.user?.email;
    if (!payerEmail) {
      return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
    }

    const db = supabaseAdmin();
    const { data: account } = await db
      .from('accounts')
      .select('subscription_status')
      .eq('id', ctx.accountId)
      .maybeSingle();
    if (account?.subscription_status === 'exempt') {
      return NextResponse.json({ error: 'not_required' }, { status: 409 });
    }
    const { data: existing } = await db
      .from('billing_subscriptions')
      .select(
        'id, plan, cycle, method, amount_cents, charges_total, charges_paid, status, mp_preapproval_id, current_period_end, canceled_at, grace_until'
      )
      .eq('account_id', ctx.accountId)
      .maybeSingle();
    if (existing?.status === 'active') {
      return NextResponse.json({ error: 'already_active' }, { status: 409 });
    }
    // A card subscription already exists at Mercado Pago and has not been
    // cancelled: starting another would charge the customer twice. Cancel
    // or change it from the billing screen instead.
    if (existing?.mp_preapproval_id && existing.status !== 'canceled') {
      return NextResponse.json(
        { error: 'subscription_exists' },
        { status: 409 }
      );
    }

    // Cancelled but still inside a paid period: keep that period, and let
    // the new card subscription charge for the first time when it ends.
    const paidUntil =
      existing?.status === 'canceled' &&
      existing.current_period_end &&
      new Date(existing.current_period_end as string) > new Date()
        ? new Date(existing.current_period_end as string)
        : null;

    // A cancelled row may still point at its old preapproval (e.g. the card
    // grace ran out). Make sure it is cancelled at Mercado Pago before a new
    // one replaces the id here — otherwise its next retry or charge would
    // bill the customer twice and match no row of ours.
    if (existing?.mp_preapproval_id) {
      await cancelPreapproval(existing.mp_preapproval_id as string).catch(
        (err) =>
          console.error('[billing/checkout/card] old preapproval', err)
      );
    }

    const quote = quoteSubscription(plan, cycle);
    const row = {
      account_id: ctx.accountId,
      plan,
      cycle,
      method: 'card',
      amount_cents: quote.amountCents,
      charges_total: quote.chargesTotal,
      charges_paid: 0,
      status: 'pending',
      mp_preapproval_id: null,
      current_period_end: paidUntil ? paidUntil.toISOString() : null,
      canceled_at: null,
      grace_until: null,
    };
    const { data: sub, error: subErr } = await db
      .from('billing_subscriptions')
      .upsert(row, { onConflict: 'account_id' })
      .select('id')
      .single();
    if (subErr || !sub) throw subErr ?? new Error('subscription row missing');

    const origin = new URL(request.url).origin;
    let preapproval;
    try {
      preapproval = await createPreapproval(
        {
          reason: `Nordia CRM ${plan} (${cycle === 'annual' ? 'anual' : 'mensal'})`,
          externalReference: String(sub.id),
          payerEmail,
          cardTokenId: cardToken,
          amount: quote.amountCents / 100,
          // Twelve charges from the FIRST one, which a resumed plan defers
          // to the end of the period already paid.
          endDate:
            quote.chargesTotal !== null
              ? addYears(paidUntil ?? new Date(), 1)
              : undefined,
          backUrl: `${origin}/onboarding/payment`,
          startDate: paidUntil ?? undefined,
        },
        // Deterministic per (subscription row, card token): a double submit
        // of the same form returns the same subscription instead of a second.
        createHash('sha256')
          .update(`${sub.id}:${cardToken}`)
          .digest('hex')
          .slice(0, 32)
      );
    } catch (err) {
      // Nothing was created at Mercado Pago: put the row back as it was, so
      // a declined card cannot leave a `pending` row that nothing charges
      // (the account would keep its access with no subscription at all).
      await restoreSubscription(db, ctx.accountId, existing).catch((e) =>
        console.error('[billing/checkout/card] restore failed', e)
      );
      if (err instanceof MercadoPagoError) {
        console.error('[billing/checkout/card]', err.message);
        return NextResponse.json(
          { error: 'provider_rejected' },
          { status: err.status === 400 ? 422 : 502 }
        );
      }
      throw err;
    }

    await db
      .from('billing_subscriptions')
      .update({ mp_preapproval_id: preapproval.id })
      .eq('id', sub.id);

    // The customer switched from Pix to card: close any Pix still waiting,
    // otherwise paying it later would charge them twice. Best effort; the
    // order also expires on its own.
    const { data: openPix } = await db
      .from('billing_pix_orders')
      .select('mp_order_id')
      .eq('account_id', ctx.accountId)
      .eq('status', 'pending');
    for (const o of openPix ?? []) {
      if (o.mp_order_id) {
        await cancelOrder(o.mp_order_id as string, randomUUID()).catch(
          () => undefined
        );
      }
    }
    if (openPix && openPix.length > 0) {
      await db
        .from('billing_pix_orders')
        .update({ status: 'canceled' })
        .eq('account_id', ctx.accountId)
        .eq('status', 'pending');
    }

    return NextResponse.json({ ok: true, status: 'pending' }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/** Undo the upsert above after Mercado Pago refused the card. */
async function restoreSubscription(
  db: ReturnType<typeof supabaseAdmin>,
  accountId: string,
  previous: Record<string, unknown> | null
) {
  if (!previous) {
    await db
      .from('billing_subscriptions')
      .delete()
      .eq('account_id', accountId)
      .eq('status', 'pending')
      .is('mp_preapproval_id', null);
    return;
  }
  const { id: _id, ...fields } = previous;
  void _id;
  await db
    .from('billing_subscriptions')
    .update({ ...fields, mp_preapproval_id: null })
    .eq('account_id', accountId);
}

function addYears(d: Date, n: number): Date {
  const out = new Date(d.getTime());
  out.setUTCFullYear(out.getUTCFullYear() + n);
  return out;
}
