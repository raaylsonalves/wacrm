// ============================================================
// POST /api/notifications/push-test — send a test push to the
// caller's own subscribed devices only, so a user can confirm push
// reaches their phone without waiting for a real customer message.
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { getVapidConfig, sendPushToAccount } from '@/lib/push/send';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

export async function POST(request: Request) {
  try {
    const ctx = await getCurrentAccount();

    const limit = checkRateLimit(
      `push-test:${ctx.userId}`,
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
    const title =
      typeof body?.title === 'string' ? body.title.slice(0, 100) : 'wacrm';
    const text = typeof body?.body === 'string' ? body.body.slice(0, 200) : '';

    const result = await sendPushToAccount(
      supabaseAdmin(),
      ctx.accountId,
      {
        title,
        body: text,
        conversationId: 'wacrm-test-push',
        url: '/settings?tab=profile',
      },
      { onlyUserId: ctx.userId }
    );

    return NextResponse.json(result);
  } catch (err) {
    return toErrorResponse(err);
  }
}
