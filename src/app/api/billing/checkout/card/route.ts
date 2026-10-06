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

import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { canManageBilling } from '@/lib/auth/roles';
import { supabaseAdmin } from '@/lib/ai/admin-client';
import { MercadoPagoError, createPreapproval } from '@/lib/billing/mercadopago';
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
    const ctx = await requireRole('owner');
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
      .select('id, status')
      .eq('account_id', ctx.accountId)
      .maybeSingle();
    if (existing?.status === 'active') {
      return NextResponse.json({ error: 'already_active' }, { status: 409 });
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
      current_period_end: null,
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
          endDate:
            quote.chargesTotal !== null ? addYears(new Date(), 1) : undefined,
          backUrl: `${origin}/onboarding/payment`,
        },
        randomUUID()
      );
    } catch (err) {
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

    return NextResponse.json({ ok: true, status: 'pending' }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}

function addYears(d: Date, n: number): Date {
  const out = new Date(d.getTime());
  out.setUTCFullYear(out.getUTCFullYear() + n);
  return out;
}
