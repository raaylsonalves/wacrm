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

/**
 * Whether this deployment has a single shared WAHA instance configured
 * at the installation level, deskcomm-style — set once in the host's
 * env vars rather than per-account. When true, POST always connects
 * against it and the frontend can skip asking for a base URL/API key
 * even on the very first channel (deskcomm never asks at all, because
 * this is the only mode it supports).
 */
function globalWahaInstance(): { baseUrl: string; apiKey: string } | null {
  const baseUrl = process.env.WAHA_API_BASE_URL?.trim();
  const apiKey = process.env.WAHA_API_KEY?.trim();
  if (!baseUrl || !apiKey) return null;
  return { baseUrl, apiKey };
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

    return NextResponse.json({
      channels: data ?? [],
      hasGlobalInstance: globalWahaInstance() !== null,
    });
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

    // Both omitted → resolve an instance without asking again, same
    // as deskcomm's single-shared-instance flow (one-click "+ Connect"
    // straight to the QR):
    //   1. An installation-wide WAHA_API_BASE_URL/WAHA_API_KEY, if the
    //      host configured one — takes priority since it's a
    //      deliberate deploy-time choice, and matches deskcomm exactly
    //      (deskcomm has no per-account instance at all).
    //   2. Otherwise, this account's most recently connected WAHA
    //      instance — the self-hoster's own bring-your-own-instance
    //      case, one server shared across the account's numbers.
    // An explicit baseUrl/apiKey pair still overrides both, for the
    // rarer case of a channel pointed at a different instance.
    if (!baseUrl && !apiKey) {
      const global = globalWahaInstance();
      if (global) {
        baseUrl = global.baseUrl;
        apiKey = global.apiKey;
      } else {
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
