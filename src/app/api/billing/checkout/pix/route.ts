// ============================================================
// POST /api/billing/checkout/pix — open a Pix charge for the current
// billing month (Orders API). The browser sends only { plan, cycle };
// the price comes from lib/billing/plans. The response carries the QR
// code and the copia-e-cola text to render on our own screen. Nothing
// is activated here: the verified webhook (Order topic) does that.
//
// Calling it again while the month's order is still open returns the
// same QR instead of creating a second charge.
// ============================================================

import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { canManageBilling } from '@/lib/auth/roles';
import { supabaseAdmin } from '@/lib/ai/admin-client';
import {
  MercadoPagoError,
  cancelOrder,
  createPixOrder,
  extractPixPayment,
  getOrder,
} from '@/lib/billing/mercadopago';
import { applyNotification } from '@/lib/billing/apply';
import { pixOrderStatus } from '@/lib/billing/transitions';
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
/** A Pix is payable for a day; the month's charge is renewed after that. */
const EXPIRES_IN = 'P1D';

function monthStart(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    .toISOString()
    .slice(0, 10);
}

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
      payerEmail?: unknown;
    } | null;
    const { plan, cycle } = body ?? {};
    if (!isPlanId(plan) || !isBillingCycle(cycle)) {
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
        'status, method, amount_cents, mp_preapproval_id, current_period_end'
      )
      .eq('account_id', ctx.accountId)
      .maybeSingle();
    // A Pix month that went unpaid (past_due, in grace): charge that same
    // month again without rewriting the row, so the paid count and the
    // period carry over and the payment extends the period it is late for.
    const overdue =
      existing?.status === 'past_due' &&
      existing.method === 'pix' &&
      !!existing.current_period_end;
    if (existing?.status === 'active') {
      return NextResponse.json({ error: 'already_active' }, { status: 409 });
    }
    // Cancelled but still inside the period already paid: nothing is owed
    // yet. Reactivating (POST /api/billing/reactivate) resumes it; a new
    // charge here would bill the same month twice. Checked BEFORE the row
    // is rewritten below, which would otherwise erase the paid period.
    if (
      existing?.status === 'canceled' &&
      existing.current_period_end &&
      new Date(existing.current_period_end as string) > new Date()
    ) {
      return NextResponse.json({ error: 'still_paid' }, { status: 409 });
    }
    // A card subscription still alive at Mercado Pago (e.g. past_due, being
    // retried): replacing its row with Pix would leave the card charging
    // too. Change the card or cancel first.
    if (existing?.mp_preapproval_id && existing.status !== 'canceled') {
      return NextResponse.json(
        { error: 'subscription_exists' },
        { status: 409 }
      );
    }

    const amountCents = overdue
      ? (existing.amount_cents as number)
      : quoteSubscription(plan, cycle).amountCents;
    const quote = { ...quoteSubscription(plan, cycle), amountCents };

    // Which charge this is. An overdue month is keyed like the sweep keys
    // its renewal (the month the period ended in), so it reuses or replaces
    // that same charge. A new purchase is keyed by today: keying it by the
    // month made a lapsed account that had paid earlier in the same month
    // unable to buy again (the paid row looked like "already paid").
    const now = new Date();
    const period = overdue
      ? monthStart(new Date(existing.current_period_end as string))
      : now.toISOString().slice(0, 10);
    const { data: open } = await db
      .from('billing_pix_orders')
      .select(
        'status, mp_order_id, amount_cents, qr_code, qr_code_base64, ticket_url, expires_at'
      )
      .eq('account_id', ctx.accountId)
      .eq('period_start', period)
      .maybeSingle();
    // This charge was already paid: never replace the record or ask twice.
    // Checked BEFORE the subscription row is rewritten below.
    if (open?.status === 'paid') {
      return NextResponse.json({ error: 'already_paid' }, { status: 409 });
    }

    if (!overdue) {
      const { error: subErr } = await db.from('billing_subscriptions').upsert(
        {
          account_id: ctx.accountId,
          plan,
          cycle,
          method: 'pix',
          amount_cents: quote.amountCents,
          charges_total: quote.chargesTotal,
          charges_paid: 0,
          status: 'pending',
          mp_preapproval_id: null,
          current_period_end: null,
          canceled_at: null,
          grace_until: null,
        },
        { onConflict: 'account_id' }
      );
      if (subErr) throw subErr;
    }

    const stillOpen =
      open &&
      open.status === 'pending' &&
      open.amount_cents === quote.amountCents &&
      open.expires_at &&
      new Date(open.expires_at as string) > now;
    if (stillOpen) {
      return NextResponse.json({ ok: true, pix: toClient(open) });
    }

    // The open Pix is about to be replaced (another plan/cycle, or expired
    // on our side). Its row is overwritten below, so a later payment of the
    // OLD QR code would no longer match anything and never activate the
    // account. Close it at Mercado Pago first; if it was in fact paid in
    // the meantime, credit it instead of creating a second charge.
    if (open?.status === 'pending' && open.mp_order_id) {
      const oldId = open.mp_order_id as string;
      const current = await getOrder(oldId).catch(() => null);
      if (current && pixOrderStatus(current.status) === 'paid') {
        await applyNotification(db, 'pix', 'order', oldId);
        return NextResponse.json({ error: 'already_paid' }, { status: 409 });
      }
      await cancelOrder(oldId, randomUUID()).catch((err) => {
        console.error('[billing/checkout/pix] could not cancel old order', err);
      });
    }

    const externalReference = randomUUID();
    let order;
    try {
      order = await createPixOrder(
        {
          externalReference,
          amountCents: quote.amountCents,
          payerEmail,
          expiresIn: EXPIRES_IN,
        },
        randomUUID()
      );
    } catch (err) {
      if (err instanceof MercadoPagoError) {
        console.error('[billing/checkout/pix]', err.message);
        return NextResponse.json(
          { error: 'provider_rejected' },
          { status: err.status === 400 ? 422 : 502 }
        );
      }
      throw err;
    }

    const pix = extractPixPayment(order);
    const row = {
      account_id: ctx.accountId,
      external_reference: externalReference,
      mp_order_id: order.id,
      amount_cents: quote.amountCents,
      period_start: period,
      status: 'pending',
      qr_code: pix.qrCode,
      qr_code_base64: pix.qrCodeBase64,
      ticket_url: pix.ticketUrl,
      expires_at: new Date(Date.now() + 24 * 3_600_000).toISOString(),
      paid_at: null,
    };
    // One charge per account per month: an expired/cancelled one from this
    // month is replaced by the new order.
    const { error: orderErr } = await db
      .from('billing_pix_orders')
      .upsert(row, { onConflict: 'account_id,period_start' });
    if (orderErr) throw orderErr;

    return NextResponse.json({ ok: true, pix: toClient(row) }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}

function toClient(r: {
  qr_code?: unknown;
  qr_code_base64?: unknown;
  ticket_url?: unknown;
  expires_at?: unknown;
}) {
  return {
    qrCode: (r.qr_code as string | null) ?? null,
    qrCodeBase64: (r.qr_code_base64 as string | null) ?? null,
    ticketUrl: (r.ticket_url as string | null) ?? null,
    expiresAt: (r.expires_at as string | null) ?? null,
  };
}
