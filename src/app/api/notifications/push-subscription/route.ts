// ============================================================
// /api/notifications/push-subscription — this device's Web Push
// subscription (specs/pwa-web-push-notifications.md).
//
//   GET    — whether push is configured on this deployment, plus the
//            public VAPID key the browser subscribes with.
//   POST   — upsert this browser's subscription for the caller.
//   DELETE — remove it (`{ endpoint }`), only if it's the caller's.
//
// Any member may call this — a user manages their own devices, not an
// account-wide setting. Writes use the service role because the same
// endpoint can legitimately move between users on a shared device
// (see migration 071's header); the caller's identity still comes from
// their session, never from the body.
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { getVapidConfig } from '@/lib/push/send';
import { isDeliverableUrl } from '@/lib/webhooks/ssrf';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

function bad(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

export async function GET() {
  try {
    await getCurrentAccount();
    const vapid = getVapidConfig();
    return NextResponse.json({
      configured: vapid !== null,
      publicKey: vapid?.publicKey ?? null,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await getCurrentAccount();

    const limit = checkRateLimit(
      `push-sub:${ctx.userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    if (!getVapidConfig()) {
      return NextResponse.json(
        { error: 'Push notifications are not configured on this server' },
        { status: 503 }
      );
    }

    const body = await request.json().catch(() => null);
    const endpoint = typeof body?.endpoint === 'string' ? body.endpoint : '';
    const p256dh =
      typeof body?.keys?.p256dh === 'string' ? body.keys.p256dh : '';
    const auth = typeof body?.keys?.auth === 'string' ? body.keys.auth : '';
    if (!endpoint || !p256dh || !auth) return bad('Invalid subscription');
    if (endpoint.length > 2048 || p256dh.length > 256 || auth.length > 256) {
      return bad('Invalid subscription');
    }
    // The server POSTs to this URL on every inbound message, so it gets
    // the same SSRF guard as user-supplied outbound webhook URLs. Real
    // push services (FCM, Mozilla, Apple) are public HTTPS hosts.
    if (
      !endpoint.startsWith('https://') ||
      !(await isDeliverableUrl(endpoint))
    ) {
      return bad('Invalid subscription endpoint');
    }

    const userAgent = request.headers.get('user-agent')?.slice(0, 512) ?? null;

    const { error } = await supabaseAdmin().from('push_subscriptions').upsert(
      {
        account_id: ctx.accountId,
        user_id: ctx.userId,
        endpoint,
        p256dh,
        auth_key: auth,
        user_agent: userAgent,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'endpoint' }
    );
    if (error) {
      console.error('[push-subscription POST] upsert failed:', error);
      return NextResponse.json(
        { error: 'Failed to save subscription' },
        { status: 500 }
      );
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(request: Request) {
  try {
    const ctx = await getCurrentAccount();
    const body = await request.json().catch(() => null);
    const endpoint = typeof body?.endpoint === 'string' ? body.endpoint : '';
    if (!endpoint) return bad('endpoint is required');

    const { error } = await supabaseAdmin()
      .from('push_subscriptions')
      .delete()
      .eq('endpoint', endpoint)
      .eq('user_id', ctx.userId);
    if (error) {
      console.error('[push-subscription DELETE] failed:', error);
      return NextResponse.json(
        { error: 'Failed to remove subscription' },
        { status: 500 }
      );
    }
    return NextResponse.json({ success: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
