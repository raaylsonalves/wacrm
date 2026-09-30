import crypto from 'crypto';
import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  AUTH_URL,
  googleCalendarEnabled,
  googleClient,
  redirectUri,
} from '@/lib/google-calendar/google-api';
import {
  GOOGLE_SCOPES,
  PKCE_COOKIE,
  pkceChallenge,
  signState,
} from '@/lib/google-calendar/logic';

const TEN_MIN = 10 * 60;

/**
 * GET /api/integrations/google-calendar/start  (admin+)
 *
 * Sends the admin to Google's consent screen for the account's shared
 * calendar. `state` is HMAC-signed, expires in 10 minutes and binds the
 * account and the user; the PKCE verifier and a nonce live in an httpOnly
 * cookie scoped to this route family, so a callback opened in another
 * browser or replayed later is rejected.
 */
export async function GET(request: Request) {
  try {
    if (!(await googleCalendarEnabled())) {
      return NextResponse.json(
        { error: 'Google Calendar is not configured' },
        { status: 404 }
      );
    }
    const { accountId, userId } = await requireRole('admin');
    const nonce = crypto.randomBytes(16).toString('base64url');
    const verifier = crypto.randomBytes(48).toString('base64url');
    const state = signState(
      { accountId, userId, nonce, exp: Date.now() + TEN_MIN * 1000 },
      process.env.ENCRYPTION_KEY!
    );
    const origin = new URL(request.url).origin;
    const url = new URL(AUTH_URL);
    url.search = new URLSearchParams({
      client_id: (await googleClient()).id,
      redirect_uri: redirectUri(origin),
      response_type: 'code',
      scope: GOOGLE_SCOPES.join(' '),
      // offline + consent: without both, Google omits the refresh token on
      // a second connection and the sync would die an hour later.
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      state,
      code_challenge: pkceChallenge(verifier),
      code_challenge_method: 'S256',
    }).toString();

    const res = NextResponse.redirect(url.toString());
    res.cookies.set(PKCE_COOKIE, `${nonce}.${verifier}`, {
      httpOnly: true,
      secure: origin.startsWith('https://'),
      sameSite: 'lax',
      path: '/api/integrations/google-calendar',
      maxAge: TEN_MIN,
    });
    return res;
  } catch (err) {
    return toErrorResponse(err);
  }
}
