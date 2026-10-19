// ============================================================
// /api/whatsapp/signup — connect a number through Meta's hosted
// Embedded Signup (specs/whatsapp-coexistence.md).
//
//   GET   the account's recent attempts (the settings card polls them)
//   POST  { phone, mode }  record who is connecting which number, and
//         return Meta's hosted link. Meta's webhook carries no state of
//         ours, so the number is how the result finds this account.
// ============================================================

import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/ai/admin-client';
import { canAddWhatsappNumber } from '@/lib/billing/number-limit';
import { hostedSignupUrl, type SignupMode } from '@/lib/whatsapp/coexistence';
import { normalizePhone } from '@/lib/whatsapp/phone-utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function hostedConfig() {
  const appId = process.env.META_APP_ID?.trim();
  const configId = process.env.META_ES_CONFIG_ID?.trim();
  return appId && configId ? { appId, configId } : null;
}

export async function GET() {
  try {
    const { supabase, accountId } = await requireRole('admin');
    const { data, error } = await supabase
      .from('whatsapp_signups')
      .select(
        'id, phone_digits, mode, status, display_phone_number, error, created_at, updated_at'
      )
      .eq('account_id', accountId)
      .order('created_at', { ascending: false })
      .limit(5);
    if (error) throw error;
    return NextResponse.json({
      available: !!hostedConfig(),
      signups: data ?? [],
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const { accountId, userId } = await requireRole('admin');
    const cfg = hostedConfig();
    if (!cfg)
      return NextResponse.json({ error: 'not_configured' }, { status: 503 });

    const body = (await request.json().catch(() => null)) as {
      phone?: unknown;
      mode?: unknown;
    } | null;
    const phone = normalizePhone(
      typeof body?.phone === 'string' ? body.phone : ''
    );
    const mode: SignupMode = body?.mode === 'api' ? 'api' : 'coexistence';
    // Country code + area code + number: 10 to 15 digits.
    if (phone.length < 10 || phone.length > 15) {
      return NextResponse.json({ error: 'invalid_phone' }, { status: 400 });
    }

    const db = supabaseAdmin();
    const limit = await canAddWhatsappNumber(db, accountId);
    if (!limit.allowed) {
      return NextResponse.json(
        { error: 'number_limit', limit: limit.limit },
        { status: 409 }
      );
    }

    // One live request per account: a new one replaces the old.
    await db
      .from('whatsapp_signups')
      .update({ status: 'failed', error: 'replaced' })
      .eq('account_id', accountId)
      .eq('status', 'waiting');
    const { error } = await db
      .from('whatsapp_signups')
      .insert({
        account_id: accountId,
        requested_by: userId,
        phone_digits: phone,
        mode,
        status: 'waiting',
      });
    if (error) throw error;

    return NextResponse.json({ url: hostedSignupUrl({ ...cfg, mode }) });
  } catch (err) {
    return toErrorResponse(err);
  }
}
