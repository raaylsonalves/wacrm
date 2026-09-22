// ============================================================
// /api/whatsapp/waha/channels/[id]
//
//   GET    — refresh + return this channel's live status from WAHA
//            (the connect UI polls this while waiting for the QR
//            scan to land).
//   DELETE — disconnect: deletes the WAHA session, then the row.
//            Any conversation pointing at this channel keeps its
//            `whatsapp_channel_id` — the FK is ON DELETE SET NULL
//            (migration 056), so history isn't lost, it just falls
//            back to "no channel" (same as before this feature).
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { decrypt } from '@/lib/whatsapp/encryption';
import {
  deleteWahaSession,
  getWahaSessionStatus,
  WahaApiError,
} from '@/lib/whatsapp/waha-api';

async function loadOwnedChannel(
  ctx: Awaited<ReturnType<typeof requireRole>>,
  id: string
) {
  const { data, error } = await ctx.supabase
    .from('whatsapp_waha_channels')
    .select('*')
    .eq('id', id)
    .eq('account_id', ctx.accountId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireRole('viewer');
    const { id } = await params;

    const channel = await loadOwnedChannel(ctx, id);
    if (!channel) {
      return NextResponse.json({ error: 'Channel not found' }, { status: 404 });
    }

    let wahaStatus: string;
    try {
      const session = await getWahaSessionStatus(
        channel.waha_base_url,
        decrypt(channel.waha_api_key),
        channel.waha_session_name
      );
      wahaStatus = session.status;
    } catch (err) {
      // The WAHA instance being unreachable is itself the answer —
      // report disconnected rather than 502ing a page that's just
      // polling for progress.
      console.warn(
        `[GET /api/whatsapp/waha/channels/${id}] status check failed:`,
        err instanceof WahaApiError ? err.message : err
      );
      wahaStatus = 'FAILED';
    }

    const nextStatus =
      wahaStatus === 'WORKING'
        ? 'connected'
        : wahaStatus === 'FAILED' || wahaStatus === 'STOPPED'
          ? 'disconnected'
          : 'connecting';

    if (nextStatus !== channel.status) {
      await ctx.supabase
        .from('whatsapp_waha_channels')
        .update({
          status: nextStatus,
          connected_at:
            nextStatus === 'connected'
              ? new Date().toISOString()
              : channel.connected_at,
        })
        .eq('id', id);
    }

    return NextResponse.json({
      id: channel.id,
      label: channel.label,
      status: nextStatus,
      waha_status: wahaStatus,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireRole('admin');
    const { id } = await params;

    const channel = await loadOwnedChannel(ctx, id);
    if (!channel) {
      return NextResponse.json({ error: 'Channel not found' }, { status: 404 });
    }

    try {
      await deleteWahaSession(
        channel.waha_base_url,
        decrypt(channel.waha_api_key),
        channel.waha_session_name
      );
    } catch (err) {
      // Best-effort — the WAHA instance may already be gone, or the
      // session already stopped. Either way, remove our own record so
      // the account isn't stuck with a channel it can't get rid of.
      console.warn(
        `[DELETE /api/whatsapp/waha/channels/${id}] session delete failed, removing row anyway:`,
        err instanceof WahaApiError ? err.message : err
      );
    }

    const { error: deleteErr } = await ctx.supabase
      .from('whatsapp_waha_channels')
      .delete()
      .eq('id', id)
      .eq('account_id', ctx.accountId);

    if (deleteErr) {
      console.error(
        `[DELETE /api/whatsapp/waha/channels/${id}] row delete failed:`,
        deleteErr
      );
      return NextResponse.json(
        { error: 'Failed to remove channel' },
        { status: 500 }
      );
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
