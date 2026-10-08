// ============================================================
// POST /api/platform/subscribers/:id — billing actions on one customer
// account, for the platform's admins only.
//
//   { action: 'exempt' }            release the account (no billing)
//   { action: 'require_payment' }   undo a release: back to `pending`
//   { action: 'extend', days }      extend the paid period (7..90 days)
//
// Every action is written to the customer's audit log, which the
// customer's admins can read.
// ============================================================

import { NextResponse } from 'next/server';
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/ai/admin-client';
import { audit } from '@/lib/audit';
import { isPlatformAdmin, platformAccountId } from '@/lib/platform/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await getCurrentAccount({ allowUnpaid: true });
    if (!(await isPlatformAdmin(ctx.userId))) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 });
    }
    const { id } = await params;
    if (!UUID.test(id) || id === platformAccountId()) {
      return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
    }
    const body = (await request.json().catch(() => null)) as {
      action?: unknown;
      days?: unknown;
    } | null;
    const action = body?.action;
    const db = supabaseAdmin();

    const { data: account } = await db
      .from('accounts')
      .select('id, subscription_status')
      .eq('id', id)
      .maybeSingle();
    if (!account) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }

    if (action === 'exempt' || action === 'require_payment') {
      const next = action === 'exempt' ? 'exempt' : 'pending';
      const { error } = await db
        .from('accounts')
        .update({ subscription_status: next })
        .eq('id', id);
      if (error) throw error;
      void audit({
        accountId: id,
        actorUserId: ctx.userId,
        action: `billing.${action}`,
        resourceType: 'account',
        resourceId: id,
        metadata: { from: account.subscription_status, to: next },
      });
      return NextResponse.json({ ok: true });
    }

    // Custom plan: how many WhatsApp numbers the account may connect
    // (migration 116). null restores the default (1; unlimited if exempt).
    if (action === 'set_number_limit') {
      const raw = (body as { limit?: unknown } | null)?.limit;
      const limit =
        raw === null || raw === undefined || raw === ''
          ? null
          : Number(raw);
      if (limit !== null && (!Number.isInteger(limit) || limit < 1 || limit > 50)) {
        return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
      }
      const { error } = await db
        .from('accounts')
        .update({ max_whatsapp_numbers: limit })
        .eq('id', id);
      if (error) throw error;
      void audit({
        accountId: id,
        actorUserId: ctx.userId,
        action: 'billing.number_limit',
        resourceType: 'account',
        resourceId: id,
        metadata: { limit },
      });
      return NextResponse.json({ ok: true });
    }

    if (action === 'extend') {
      const days = Number(body?.days);
      if (!Number.isInteger(days) || days < 7 || days > 90) {
        return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
      }
      const { data: sub } = await db
        .from('billing_subscriptions')
        .select('id, method, status, mp_preapproval_id, current_period_end')
        .eq('account_id', id)
        .maybeSingle();
      if (!sub) {
        return NextResponse.json({ error: 'no_subscription' }, { status: 409 });
      }
      // Mercado Pago charges a live card subscription on its own schedule:
      // moving our date would not move that charge, only make them disagree.
      if (
        sub.method === 'card' &&
        sub.mp_preapproval_id &&
        (sub.status === 'active' || sub.status === 'past_due')
      ) {
        return NextResponse.json({ error: 'card_managed' }, { status: 409 });
      }
      const from = Math.max(
        Date.now(),
        sub.current_period_end
          ? new Date(sub.current_period_end as string).getTime()
          : 0
      );
      const end = new Date(from + days * 86_400_000).toISOString();
      const { error: subErr } = await db
        .from('billing_subscriptions')
        .update({ current_period_end: end, grace_until: null })
        .eq('id', sub.id);
      if (subErr) throw subErr;
      // A late or closed account gets its access back for the extension.
      if (account.subscription_status !== 'exempt') {
        const { error } = await db
          .from('accounts')
          .update({ subscription_status: 'active' })
          .eq('id', id);
        if (error) throw error;
      }
      void audit({
        accountId: id,
        actorUserId: ctx.userId,
        action: 'billing.extended',
        resourceType: 'account',
        resourceId: id,
        metadata: { days, until: end },
      });
      return NextResponse.json({ ok: true, until: end });
    }

    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
