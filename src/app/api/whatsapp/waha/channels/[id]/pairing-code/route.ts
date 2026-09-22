// ============================================================
// POST /api/whatsapp/waha/channels/[id]/pairing-code
//
// Alternative to GET .../qr: requests a pairing code the user types
// into WhatsApp (Linked Devices → Link with phone number) instead of
// scanning a QR image. Same channel/session, same 'connecting' state
// machine — WAHA flips the session to WORKING once the phone confirms
// the code, exactly like it does after a QR scan.
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';
import { decrypt } from '@/lib/whatsapp/encryption';
import { requestWahaPairingCode, WahaApiError } from '@/lib/whatsapp/waha-api';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireRole('admin');
    const { id } = await params;

    const limit = checkRateLimit(
      `admin:wahaPairingCode:${ctx.userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const body = await request.json().catch(() => ({}));
    const rawPhone = typeof body.phone === 'string' ? body.phone : '';
    const phoneNumber = rawPhone.replace(/\D/g, '');
    if (!phoneNumber) {
      return NextResponse.json({ error: 'phone is required' }, { status: 400 });
    }

    const { data: channel, error } = await ctx.supabase
      .from('whatsapp_waha_channels')
      .select('waha_base_url, waha_api_key, waha_session_name, status')
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .maybeSingle();

    if (error || !channel) {
      return NextResponse.json({ error: 'Channel not found' }, { status: 404 });
    }
    if (channel.status === 'connected') {
      return NextResponse.json(
        { error: 'Channel is already connected' },
        { status: 409 }
      );
    }

    try {
      const code = await requestWahaPairingCode(
        channel.waha_base_url,
        decrypt(channel.waha_api_key),
        channel.waha_session_name,
        phoneNumber
      );
      return NextResponse.json({ code });
    } catch (err) {
      const message =
        err instanceof WahaApiError
          ? err.message
          : 'Could not request a pairing code';
      return NextResponse.json({ error: message }, { status: 502 });
    }
  } catch (err) {
    return toErrorResponse(err);
  }
}
