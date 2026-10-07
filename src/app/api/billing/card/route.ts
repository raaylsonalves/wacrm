// ============================================================
// POST /api/billing/card — the owner swaps the card of their subscription.
//
// The browser tokenises the new card with Mercado Pago's form and sends
// only { cardToken }. The existing preapproval is updated in place (no new
// subscription, no second charge); Mercado Pago's pending retries of a
// declined charge then use the new card. A cancelled subscription cannot
// be changed: subscribing again goes through /api/billing/checkout/card.
// ============================================================

import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { canManageBilling } from '@/lib/auth/roles';
import { supabaseAdmin } from '@/lib/ai/admin-client';
import {
  MercadoPagoError,
  updatePreapprovalCard,
} from '@/lib/billing/mercadopago';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const LIMIT = { limit: 5, windowMs: 10 * 60_000 };

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('owner', { allowUnpaid: true });
    if (!canManageBilling(ctx.role)) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 });
    }
    const limit = checkRateLimit(`billing:card:${ctx.userId}`, LIMIT);
    if (!limit.success) return rateLimitResponse(limit);

    const body = (await request.json().catch(() => null)) as {
      cardToken?: unknown;
    } | null;
    const cardToken = body?.cardToken;
    if (
      typeof cardToken !== 'string' ||
      cardToken.length < 8 ||
      cardToken.length > 200
    ) {
      return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
    }

    const db = supabaseAdmin();
    const { data: sub } = await db
      .from('billing_subscriptions')
      .select('method, status, mp_preapproval_id')
      .eq('account_id', ctx.accountId)
      .maybeSingle();
    if (
      !sub ||
      sub.method !== 'card' ||
      !sub.mp_preapproval_id ||
      (sub.status !== 'active' && sub.status !== 'past_due')
    ) {
      return NextResponse.json(
        { error: 'no_card_subscription' },
        { status: 409 }
      );
    }

    try {
      await updatePreapprovalCard(sub.mp_preapproval_id as string, cardToken);
    } catch (err) {
      if (err instanceof MercadoPagoError) {
        console.error('[billing/card]', err.message);
        return NextResponse.json(
          { error: 'provider_rejected' },
          { status: err.status === 400 ? 422 : 502 }
        );
      }
      throw err;
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
