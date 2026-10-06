// GET /api/billing/status — what the payment screen polls while the
// webhook is in flight, and what Settings > Billing will show. Members
// read it through RLS (their own account only); no secrets, no raw
// provider payloads.

import { NextResponse } from 'next/server';
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/ai/admin-client';
import { applyNotification } from '@/lib/billing/apply';

export const dynamic = 'force-dynamic';

// A webhook can be late or never arrive (misconfigured topic, MP outage).
// While the account is still pending, this route asks Mercado Pago itself
// about the account's own open charge and applies the answer through the
// same code path as the webhook. The client never supplies an id: both ids
// come from our rows for the signed-in account, so there is nothing to
// forge. Throttled per account so the 4 s poll does not hammer the API.
const RECONCILE_EVERY_MS = 8_000;
const lastReconcile = new Map<string, number>();

async function reconcilePending(accountId: string): Promise<void> {
  const now = Date.now();
  if (now - (lastReconcile.get(accountId) ?? 0) < RECONCILE_EVERY_MS) return;
  lastReconcile.set(accountId, now);
  try {
    const db = supabaseAdmin();
    const [{ data: sub }, { data: pix }] = await Promise.all([
      db
        .from('billing_subscriptions')
        .select('mp_preapproval_id, status')
        .eq('account_id', accountId)
        .maybeSingle(),
      db
        .from('billing_pix_orders')
        .select('mp_order_id')
        .eq('account_id', accountId)
        .eq('status', 'pending')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);
    if (sub?.mp_preapproval_id && sub.status === 'pending') {
      await applyNotification(
        db,
        'subs',
        'subscription_preapproval',
        sub.mp_preapproval_id as string
      );
    }
    if (pix?.mp_order_id) {
      await applyNotification(db, 'pix', 'order', pix.mp_order_id as string);
    }
  } catch (err) {
    console.error('[billing/status] reconcile failed', err);
  }
}

export async function GET() {
  try {
    const ctx = await getCurrentAccount({ allowUnpaid: true });
    if (ctx.subscriptionStatus === 'pending') {
      await reconcilePending(ctx.accountId);
    }
    const [{ data: account }, { data: sub }, { data: pix }] = await Promise.all(
      [
        ctx.supabase
          .from('accounts')
          .select('subscription_status')
          .eq('id', ctx.accountId)
          .maybeSingle(),
        ctx.supabase
          .from('billing_subscriptions')
          .select(
            'plan, cycle, method, amount_cents, status, current_period_end, canceled_at'
          )
          .eq('account_id', ctx.accountId)
          .maybeSingle(),
        ctx.supabase
          .from('billing_pix_orders')
          .select('status, qr_code, qr_code_base64, ticket_url, expires_at')
          .eq('account_id', ctx.accountId)
          .eq('status', 'pending')
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
      ]
    );
    return NextResponse.json({
      subscriptionStatus: account?.subscription_status ?? null,
      subscription: sub ?? null,
      openPixOrder: pix ?? null,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
