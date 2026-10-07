// ============================================================
// GET /api/platform/subscribers — every customer account's billing, for
// the platform's admins (lib/platform/admin.ts). Billing facts only: plan,
// method, status, next charge and payments. No conversation, contact or
// message data is read here.
// ============================================================

import { NextResponse } from 'next/server';
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/ai/admin-client';
import { isPlatformAdmin, platformAccountId } from '@/lib/platform/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const ctx = await getCurrentAccount({ allowUnpaid: true });
    if (!(await isPlatformAdmin(ctx.userId))) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 });
    }
    const db = supabaseAdmin();
    const platform = platformAccountId();

    const [{ data: accounts }, { data: subs }, { data: payments }] =
      await Promise.all([
        db
          .from('accounts')
          .select(
            'id, name, created_at, subscription_status, managed_by, owner_user_id'
          )
          .order('created_at', { ascending: false })
          .limit(1000),
        db
          .from('billing_subscriptions')
          .select(
            'account_id, plan, cycle, method, amount_cents, status, current_period_end, grace_until, canceled_at'
          ),
        db
          .from('billing_payments')
          .select('account_id, method, amount_cents, paid_at')
          .order('paid_at', { ascending: false })
          .limit(5000),
      ]);

    // Owner e-mails, so the customer can be reached.
    const emails = new Map<string, string>();
    for (let page = 1; page <= 10; page++) {
      const { data } = await db.auth.admin.listUsers({ page, perPage: 1000 });
      for (const u of data?.users ?? []) if (u.email) emails.set(u.id, u.email);
      if (!data || data.users.length < 1000) break;
    }

    const subByAccount = new Map(
      (subs ?? []).map((s) => [s.account_id as string, s])
    );
    const paysByAccount = new Map<
      string,
      { method: string; amount_cents: number; paid_at: string }[]
    >();
    for (const p of payments ?? []) {
      const list = paysByAccount.get(p.account_id as string) ?? [];
      list.push({
        method: p.method as string,
        amount_cents: p.amount_cents as number,
        paid_at: p.paid_at as string,
      });
      paysByAccount.set(p.account_id as string, list);
    }

    const rows = (accounts ?? [])
      .filter((a) => a.id !== platform)
      .map((a) => {
        const pays = paysByAccount.get(a.id as string) ?? [];
        const sub = subByAccount.get(a.id as string) ?? null;
        return {
          id: a.id as string,
          name: a.name as string,
          createdAt: a.created_at as string,
          ownerEmail: a.owner_user_id
            ? (emails.get(a.owner_user_id as string) ?? null)
            : null,
          managed: !!a.managed_by,
          accountStatus: a.subscription_status as string,
          subscription: sub && {
            plan: sub.plan as string,
            cycle: sub.cycle as string,
            method: sub.method as string,
            amountCents: sub.amount_cents as number,
            status: sub.status as string,
            currentPeriodEnd: sub.current_period_end as string | null,
            graceUntil: sub.grace_until as string | null,
            canceledAt: sub.canceled_at as string | null,
          },
          totalPaidCents: pays.reduce((n, p) => n + p.amount_cents, 0),
          payments: pays.slice(0, 12).map((p) => ({
            method: p.method,
            amountCents: p.amount_cents,
            paidAt: p.paid_at,
          })),
        };
      });

    return NextResponse.json({ subscribers: rows });
  } catch (err) {
    return toErrorResponse(err);
  }
}
