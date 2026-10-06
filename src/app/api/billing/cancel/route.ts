// ============================================================
// POST /api/billing/cancel — the owner cancels the subscription.
//
// Stops future charges: a card subscription is cancelled at Mercado Pago,
// an open Pix order is cancelled and no renewal is created. Access is NOT
// cut here: it runs to the end of the period already paid, and the
// billing sweep closes the account after that (specs/mercadopago-checkout.md).
// ============================================================

import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { canManageBilling } from '@/lib/auth/roles';
import { supabaseAdmin } from '@/lib/ai/admin-client';
import {
  MercadoPagoError,
  cancelOrder,
  cancelPreapproval,
} from '@/lib/billing/mercadopago';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const LIMIT = { limit: 5, windowMs: 10 * 60_000 };

export async function POST() {
  try {
    const ctx = await requireRole('owner', { allowUnpaid: true });
    if (!canManageBilling(ctx.role)) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 });
    }
    const limit = checkRateLimit(`billing:cancel:${ctx.userId}`, LIMIT);
    if (!limit.success) return rateLimitResponse(limit);

    const db = supabaseAdmin();
    const { data: sub } = await db
      .from('billing_subscriptions')
      .select('id, method, status, mp_preapproval_id')
      .eq('account_id', ctx.accountId)
      .maybeSingle();
    if (!sub || sub.status === 'canceled') {
      return NextResponse.json({ error: 'nothing_to_cancel' }, { status: 409 });
    }

    // Card: stop the recurring charge first. If Mercado Pago cannot do it,
    // keep our state unchanged so the customer is never told "cancelled"
    // while still being billed.
    if (sub.method === 'card' && sub.mp_preapproval_id) {
      try {
        await cancelPreapproval(sub.mp_preapproval_id as string);
      } catch (err) {
        if (err instanceof MercadoPagoError) {
          console.error('[billing/cancel]', err.message);
          return NextResponse.json(
            { error: 'provider_failed' },
            { status: 502 }
          );
        }
        throw err;
      }
    }

    // Pix: close the open order(s); best effort, the order expires anyway.
    const { data: open } = await db
      .from('billing_pix_orders')
      .select('id, mp_order_id')
      .eq('account_id', ctx.accountId)
      .eq('status', 'pending');
    for (const o of open ?? []) {
      if (o.mp_order_id) {
        await cancelOrder(o.mp_order_id as string, randomUUID()).catch(
          () => undefined
        );
      }
    }
    if (open && open.length > 0) {
      await db
        .from('billing_pix_orders')
        .update({ status: 'canceled' })
        .eq('account_id', ctx.accountId)
        .eq('status', 'pending');
    }

    const { error } = await db
      .from('billing_subscriptions')
      .update({ status: 'canceled', canceled_at: new Date().toISOString() })
      .eq('id', sub.id);
    if (error) throw error;

    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
