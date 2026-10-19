// ============================================================
// POST /api/platform/whatsapp-signups/:id — finish a hosted signup that
// Meta reported but the CRM could not complete (whatsapp_signups row in
// `unmatched`): a missing request, a server misconfiguration, a Meta
// error. Platform admins only.
//
//   { accountId }   the CRM account the number belongs to
//
// Re-runs the PARTNER_ADDED handling for that row's shared account, so
// the number is stored and the one-shot syncs are requested — Meta only
// allows them within 24 h of the customer finishing the signup.
// ============================================================

import { NextResponse } from 'next/server';
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/ai/admin-client';
import { isPlatformAdmin } from '@/lib/platform/admin';
import { completeHostedSignup } from '@/lib/whatsapp/coexistence-onboard';

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
    const body = (await request.json().catch(() => null)) as {
      accountId?: unknown;
    } | null;
    const accountId = typeof body?.accountId === 'string' ? body.accountId : '';
    if (!UUID.test(id) || !UUID.test(accountId)) {
      return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
    }

    const db = supabaseAdmin();
    const [{ data: row }, { data: account }] = await Promise.all([
      db
        .from('whatsapp_signups')
        .select('id, status, waba_id, owner_business_id')
        .eq('id', id)
        .maybeSingle(),
      db
        .from('accounts')
        .select('id, owner_user_id')
        .eq('id', accountId)
        .maybeSingle(),
    ]);
    if (
      !row ||
      row.status !== 'unmatched' ||
      !row.waba_id ||
      !row.owner_business_id
    ) {
      return NextResponse.json({ error: 'not_retryable' }, { status: 409 });
    }
    if (!account?.owner_user_id) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }

    // A fresh request for that account, which the re-run then claims
    // (lib/whatsapp/coexistence matchSignup): the same path as a live one.
    await db
      .from('whatsapp_signups')
      .update({ status: 'failed', error: 'replaced' })
      .eq('account_id', accountId)
      .eq('status', 'waiting');
    const { data: claim, error: claimError } = await db
      .from('whatsapp_signups')
      .insert({
        account_id: accountId,
        requested_by: account.owner_user_id,
        mode: 'coexistence',
        status: 'waiting',
      })
      .select('id')
      .single();
    if (claimError || !claim)
      throw claimError ?? new Error('claim not created');

    await completeHostedSignup(db, {
      wabaId: row.waba_id as string,
      ownerBusinessId: row.owner_business_id as string,
    });

    const { data: result } = await db
      .from('whatsapp_signups')
      .select('status, error, display_phone_number, whatsapp_config_id')
      .eq('id', claim.id)
      .single();
    if (result?.status === 'connected') {
      await db
        .from('whatsapp_signups')
        .update({ status: 'failed', error: `retried as ${claim.id}` })
        .eq('id', id);
    }
    // The claim must not linger as "waiting" on the customer's screen.
    if (result?.status === 'waiting') {
      await db
        .from('whatsapp_signups')
        .update({ status: 'failed', error: 'retry_failed' })
        .eq('id', claim.id);
    }
    // Still not connected: the re-run left its reason on a new unmatched row.
    const { data: failure } =
      result?.status === 'connected'
        ? { data: null }
        : await db
            .from('whatsapp_signups')
            .select('id, error, created_at')
            .eq('waba_id', row.waba_id)
            .eq('status', 'unmatched')
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();
    return NextResponse.json({ result, failure });
  } catch (err) {
    return toErrorResponse(err);
  }
}
