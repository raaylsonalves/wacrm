// ============================================================
// GET /api/whatsapp/waha/channels/[id]/qr
//
// Returns the current QR code (data: URI) for a channel still in
// 'connecting'. WAHA regenerates the QR periodically until scanned,
// so the frontend re-calls this on the same poll loop it uses for
// GET /api/whatsapp/waha/channels/[id]'s status.
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { decrypt } from '@/lib/whatsapp/encryption';
import { getWahaQrCode, WahaApiError } from '@/lib/whatsapp/waha-api';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireRole('viewer');
    const { id } = await params;

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
      const qrDataUri = await getWahaQrCode(
        channel.waha_base_url,
        decrypt(channel.waha_api_key),
        channel.waha_session_name
      );
      return NextResponse.json({ qr: qrDataUri });
    } catch (err) {
      // Not just a WahaApiError → likely a network/timeout error or a
      // non-JSON response (e.g. a reverse proxy in front of the WAHA
      // VPS returning an HTML error page). Log the real cause and
      // surface its message too, rather than a message-less generic
      // string — this was previously silent and hard to diagnose.
      const message =
        err instanceof WahaApiError
          ? err.message
          : err instanceof Error
            ? `Could not fetch QR code: ${err.message}`
            : 'Could not fetch QR code';
      console.error('[GET .../waha/channels/[id]/qr] failed:', err);
      return NextResponse.json({ error: message }, { status: 502 });
    }
  } catch (err) {
    return toErrorResponse(err);
  }
}
