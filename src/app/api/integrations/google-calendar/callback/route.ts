import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import { encrypt } from '@/lib/whatsapp/encryption';
import { audit } from '@/lib/audit';
import {
  emailFromIdToken,
  exchangeCode,
  googleCalendarEnabled,
  redirectUri,
} from '@/lib/google-calendar/google-api';
import { PKCE_COOKIE, verifyState } from '@/lib/google-calendar/logic';
import { backfillConnection } from '@/lib/google-calendar/sync';

/**
 * GET /api/integrations/google-calendar/callback
 *
 * Google sends the admin back here. Everything must line up — signed,
 * unexpired state; same account and user as the current session; the
 * nonce in this browser's cookie — before the code is exchanged. The
 * refresh token is stored encrypted and never returned. Errors are
 * generic in the redirect; details only in server logs (never tokens).
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const back = (result: string) => {
    const res = NextResponse.redirect(
      new URL(`/agenda?google=${result}`, url.origin)
    );
    res.cookies.set(PKCE_COOKIE, '', {
      path: '/api/integrations/google-calendar',
      maxAge: 0,
    });
    return res;
  };

  if (!googleCalendarEnabled()) return back('unavailable');
  if (url.searchParams.get('error')) return back('denied');

  let ctx;
  try {
    ctx = await requireRole('admin');
  } catch {
    return back('forbidden');
  }

  const state = verifyState(
    url.searchParams.get('state') ?? '',
    process.env.ENCRYPTION_KEY!
  );
  const cookie = request.headers
    .get('cookie')
    ?.split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${PKCE_COOKIE}=`))
    ?.slice(PKCE_COOKIE.length + 1);
  const [nonce, verifier] = decodeURIComponent(cookie ?? '').split('.');
  const code = url.searchParams.get('code');
  if (
    !state ||
    !code ||
    !nonce ||
    !verifier ||
    state.nonce !== nonce ||
    state.accountId !== ctx.accountId ||
    state.userId !== ctx.userId
  ) {
    return back('invalid');
  }

  try {
    const tokens = await exchangeCode({
      code,
      verifier,
      redirectUri: redirectUri(url.origin),
    });
    if (!tokens.refreshToken) return back('no_refresh');
    if (!tokens.scope.includes('calendar.events')) return back('scope');
    const email = emailFromIdToken(tokens.idToken) ?? 'google';

    const db = supabaseAdmin();
    const row = {
      account_id: ctx.accountId,
      user_id: null,
      google_email: email,
      google_calendar_id: 'primary',
      refresh_token_enc: encrypt(tokens.refreshToken),
      scopes: tokens.scope.split(' '),
      status: 'active',
      last_error: null,
      last_synced_at: null,
      created_by: ctx.userId,
    };
    const { data: existing } = await db
      .from('calendar_connections')
      .select('id')
      .eq('account_id', ctx.accountId)
      .is('user_id', null)
      .maybeSingle();
    const { error } = existing
      ? await db.from('calendar_connections').update(row).eq('id', existing.id)
      : await db.from('calendar_connections').insert(row);
    if (error) {
      console.error(
        '[google-calendar] saving the connection failed:',
        error.message
      );
      return back('error');
    }
    await backfillConnection(db, ctx.accountId);
    void audit({
      accountId: ctx.accountId,
      actorUserId: ctx.userId,
      action: 'calendar.connected',
      resourceType: 'calendar_connection',
      metadata: { provider: 'google', email },
    });
    return back('connected');
  } catch (err) {
    console.error(
      '[google-calendar] callback failed:',
      err instanceof Error ? err.message : err
    );
    return back('error');
  }
}
