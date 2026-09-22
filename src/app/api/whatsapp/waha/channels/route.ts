// ============================================================
// /api/whatsapp/waha/channels
//
//   GET  — list this account's WAHA channels (no secrets returned).
//   POST — connect a new one: creates the DB row, creates the WAHA
//          session (pointed at our webhook, HMAC-signed), and leaves
//          it in 'connecting' until the QR is scanned. The frontend
//          calls GET /api/whatsapp/waha/channels/[id]/qr next.
//
// Admin+ (specs/waha-channel-connection.md), same tier as
// /api/whatsapp/config.
// ============================================================

import crypto from 'node:crypto';
import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';
import { decrypt, encrypt } from '@/lib/whatsapp/encryption';
import { isDeliverableUrl } from '@/lib/webhooks/ssrf';
import { createWahaSession, WahaApiError } from '@/lib/whatsapp/waha-api';

/**
 * Resolve the URL our webhook is reachable at, for WAHA to call back.
 * Simpler than the invite-link resolver in
 * `/api/account/invitations` (no configurable allow-list — this is a
 * server-to-server callback URL, not a link handed to end users) but
 * the same precedence: explicit env var, then the proxy headers a
 * production deploy already sets, then the request's own Host.
 */
function resolveWebhookBaseUrl(request: Request): string {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, '');

  const forwardedHost = request.headers
    .get('x-forwarded-host')
    ?.split(',')[0]
    ?.trim();
  const forwardedProto = request.headers
    .get('x-forwarded-proto')
    ?.split(',')[0]
    ?.trim();
  if (forwardedHost) return `${forwardedProto || 'https'}://${forwardedHost}`;

  const host = request.headers.get('host')?.trim();
  const proto = new URL(request.url).protocol.replace(':', '');
  return `${proto}://${host}`;
}

export async function GET() {
  try {
    // Any account member may see connection status (mirrors the
    // ai_configs_select RLS policy's reasoning: viewers should know
    // whether a channel is live, same as they can see whether AI
    // auto-reply is on).
    const ctx = await requireRole('viewer');

    const { data, error } = await ctx.supabase
      .from('whatsapp_waha_channels')
      .select('id, label, status, waha_base_url, connected_at, created_at')
      .eq('account_id', ctx.accountId)
      .order('created_at', { ascending: true });

    if (error) {
      console.error('[GET /api/whatsapp/waha/channels] fetch failed:', error);
      return NextResponse.json(
        { error: 'Failed to load channels' },
        { status: 500 }
      );
    }

    return NextResponse.json({ channels: data ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin');

    const limit = checkRateLimit(
      `admin:wahaChannelCreate:${ctx.userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const body = await request.json().catch(() => ({}));
    const label = typeof body.label === 'string' ? body.label.trim() : '';
    let baseUrl =
      typeof body.waha_base_url === 'string' ? body.waha_base_url.trim() : '';
    let apiKey =
      typeof body.waha_api_key === 'string' ? body.waha_api_key.trim() : '';

    if (!label) {
      return NextResponse.json({ error: 'label is required' }, { status: 400 });
    }

    // Both omitted → reuse the account's most recently connected WAHA
    // instance instead of asking again (mirrors deskcomm's single
    // shared-instance flow, where connecting a new number is a
    // one-click "+ Connect" straight to the QR). Same UX for the
    // common case — one WAHA server, several numbers — while still
    // letting an explicit baseUrl/apiKey pair point at a different
    // instance for the rarer multi-instance case.
    if (!baseUrl && !apiKey) {
      const { data: lastChannel } = await ctx.supabase
        .from('whatsapp_waha_channels')
        .select('waha_base_url, waha_api_key')
        .eq('account_id', ctx.accountId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (lastChannel) {
        baseUrl = lastChannel.waha_base_url;
        apiKey = decrypt(lastChannel.waha_api_key);
      }
    }

    if (!baseUrl) {
      return NextResponse.json(
        { error: 'waha_base_url is required' },
        { status: 400 }
      );
    }
    if (!apiKey) {
      return NextResponse.json(
        { error: 'waha_api_key is required' },
        { status: 400 }
      );
    }

    try {
      new URL(baseUrl);
    } catch {
      return NextResponse.json(
        { error: 'waha_base_url is not a valid URL' },
        { status: 400 }
      );
    }

    // The server is about to make requests to this URL on every
    // connect/send/status call — same SSRF exposure as an outbound
    // webhook URL (`lib/webhooks/ssrf.ts`'s own doc comment), so it
    // gets the same guard.
    if (!(await isDeliverableUrl(baseUrl))) {
      return NextResponse.json(
        { error: 'waha_base_url does not resolve to a public address' },
        { status: 400 }
      );
    }

    const sessionName = `wacrm-${crypto.randomUUID()}`;
    const webhookSecret = crypto.randomBytes(32).toString('hex');
    const webhookUrl = `${resolveWebhookBaseUrl(request)}/api/whatsapp/webhook/waha`;

    try {
      await createWahaSession(
        baseUrl,
        apiKey,
        sessionName,
        webhookUrl,
        webhookSecret
      );
    } catch (err) {
      const message =
        err instanceof WahaApiError
          ? err.message
          : 'Could not reach the WAHA instance';
      return NextResponse.json({ error: message }, { status: 502 });
    }

    const { data: channel, error: insertErr } = await ctx.supabase
      .from('whatsapp_waha_channels')
      .insert({
        account_id: ctx.accountId,
        created_by: ctx.userId,
        label,
        status: 'connecting',
        waha_base_url: baseUrl,
        waha_api_key: encrypt(apiKey),
        waha_session_name: sessionName,
        webhook_secret: encrypt(webhookSecret),
      })
      .select('id, label, status, waha_base_url, connected_at, created_at')
      .single();

    if (insertErr || !channel) {
      console.error(
        '[POST /api/whatsapp/waha/channels] insert failed:',
        insertErr
      );
      return NextResponse.json(
        { error: 'Failed to save channel' },
        { status: 500 }
      );
    }

    return NextResponse.json({ channel }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
