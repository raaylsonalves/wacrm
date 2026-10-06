// GET /api/billing/status — what the payment screen polls while the
// webhook is in flight, and what Settings > Billing will show. Members
// read it through RLS (their own account only); no secrets, no raw
// provider payloads.

import { NextResponse } from 'next/server';
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const ctx = await getCurrentAccount({ allowUnpaid: true });
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
