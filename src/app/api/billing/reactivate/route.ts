// ============================================================
// POST /api/billing/reactivate — undo a cancellation while the period
// already paid is still running. Pix only: nothing is charged now, and the
// sweep creates the next month's Pix as usual before the period ends.
//
// A card subscription cancelled at Mercado Pago cannot be resumed there;
// the owner re-enters a card instead (/api/billing/checkout/card), whose
// first charge then waits for the end of the paid period.
// ============================================================

import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { canManageBilling } from '@/lib/auth/roles';
import { supabaseAdmin } from '@/lib/ai/admin-client';
import { audit } from '@/lib/audit';
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
    const limit = checkRateLimit(`billing:reactivate:${ctx.userId}`, LIMIT);
    if (!limit.success) return rateLimitResponse(limit);

    const db = supabaseAdmin();
    const { data: sub } = await db
      .from('billing_subscriptions')
      .select('id, method, status, current_period_end, charges_paid, charges_total')
      .eq('account_id', ctx.accountId)
      .maybeSingle();
    const stillPaid =
      !!sub?.current_period_end &&
      new Date(sub.current_period_end as string) > new Date();
    if (!sub || sub.status !== 'canceled' || !stillPaid) {
      return NextResponse.json({ error: 'not_reactivatable' }, { status: 409 });
    }
    // A finished annual plan has no next charge to resume: reactivating it
    // would only fall into "overdue" at the period end for a charge that
    // does not exist. Buying a new plan is the way forward.
    if (
      sub.charges_total !== null &&
      (sub.charges_paid as number) >= (sub.charges_total as number)
    ) {
      return NextResponse.json({ error: 'plan_finished' }, { status: 409 });
    }
    if (sub.method !== 'pix') {
      return NextResponse.json({ error: 'card_required' }, { status: 409 });
    }

    const { error } = await db
      .from('billing_subscriptions')
      .update({ status: 'active', canceled_at: null })
      .eq('id', sub.id)
      .eq('status', 'canceled');
    if (error) throw error;
    const { error: accErr } = await db
      .from('accounts')
      .update({ subscription_status: 'active' })
      .eq('id', ctx.accountId)
      .neq('subscription_status', 'exempt');
    if (accErr) throw accErr;

    void audit({
      accountId: ctx.accountId,
      actorUserId: ctx.userId,
      action: 'billing.reactivated',
      resourceType: 'billing_subscription',
      resourceId: sub.id as string,
      metadata: { method: sub.method },
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
