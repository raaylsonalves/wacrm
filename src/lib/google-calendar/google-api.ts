import { decrypt } from '@/lib/whatsapp/encryption';
import { supabaseAdmin } from '@/lib/automations/admin-client';

/**
 * Thin Google OAuth + Calendar v3 client over fetch (no SDK). Tokens never
 * leave this module except as the access token handed to the next call;
 * nothing here logs a token.
 */

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
export const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const CAL = 'https://www.googleapis.com/calendar/v3';

export type GoogleCredentialSource = 'env' | 'database' | null;

/**
 * The installation's OAuth app: env vars win; otherwise the row saved from
 * the portfolio screen (migration 097). Read on every call — a new secret
 * pasted in the screen takes effect without a redeploy.
 */
export async function loadGoogleClient(): Promise<
  { id: string; secret: string; source: 'env' | 'database' } | null
> {
  const envId = process.env.GOOGLE_OAUTH_CLIENT_ID?.trim();
  const envSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim();
  if (envId && envSecret) return { id: envId, secret: envSecret, source: 'env' };
  try {
    const { data } = await supabaseAdmin()
      .from('platform_google_oauth')
      .select('client_id, client_secret_enc')
      .maybeSingle();
    if (!data) return null;
    return {
      id: data.client_id as string,
      secret: decrypt(data.client_secret_enc as string),
      source: 'database',
    };
  } catch (err) {
    console.error('[google-calendar] stored credential unreadable:', err instanceof Error ? err.message : err);
    return null;
  }
}

export async function googleCalendarEnabled(): Promise<boolean> {
  return (await loadGoogleClient()) !== null;
}

export async function googleClient(): Promise<{ id: string; secret: string }> {
  const c = await loadGoogleClient();
  if (!c) throw new Error('Google Calendar is not configured');
  return c;
}

/** The callback URL registered in Google Cloud. Must match exactly. */
export function redirectUri(requestOrigin: string): string {
  const explicit = process.env.GOOGLE_OAUTH_REDIRECT_URI?.trim();
  if (explicit) return explicit;
  const site = process.env.NEXT_PUBLIC_SITE_URL?.trim().replace(/\/+$/, '');
  return `${site || requestOrigin}/api/integrations/google-calendar/callback`;
}

export class GoogleApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    public retryAfter: string | null,
    message: string
  ) {
    super(message);
    this.name = 'GoogleApiError';
  }
}

async function fail(res: Response): Promise<never> {
  let code = `http_${res.status}`;
  let message = `Google API ${res.status}`;
  try {
    const j = (await res.json()) as {
      error?: string | { message?: string; status?: string };
      error_description?: string;
    };
    if (typeof j.error === 'string') {
      code = j.error;
      message = j.error_description || j.error;
    } else if (j.error) {
      code = j.error.status || code;
      message = j.error.message || message;
    }
  } catch {
    /* body not JSON */
  }
  throw new GoogleApiError(
    res.status,
    code,
    res.headers.get('retry-after'),
    message
  );
}

export async function exchangeCode(args: {
  code: string;
  verifier: string;
  redirectUri: string;
}): Promise<{
  refreshToken: string | null;
  accessToken: string;
  idToken: string | null;
  scope: string;
}> {
  const { id, secret } = await googleClient();
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: args.code,
      client_id: id,
      client_secret: secret,
      redirect_uri: args.redirectUri,
      grant_type: 'authorization_code',
      code_verifier: args.verifier,
    }),
  });
  if (!res.ok) await fail(res);
  const j = (await res.json()) as {
    refresh_token?: string;
    access_token: string;
    id_token?: string;
    scope?: string;
  };
  return {
    refreshToken: j.refresh_token ?? null,
    accessToken: j.access_token,
    idToken: j.id_token ?? null,
    scope: j.scope ?? '',
  };
}

/** The e-mail claim of an id_token received directly from Google's token
 *  endpoint over TLS (OIDC allows skipping signature checks in that case). */
export function emailFromIdToken(idToken: string | null): string | null {
  if (!idToken) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(idToken.split('.')[1], 'base64url').toString()
    ) as { email?: string };
    return payload.email ?? null;
  } catch {
    return null;
  }
}

export async function accessTokenFor(refreshTokenEnc: string): Promise<string> {
  const { id, secret } = await googleClient();
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: id,
      client_secret: secret,
      refresh_token: decrypt(refreshTokenEnc),
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) await fail(res);
  return ((await res.json()) as { access_token: string }).access_token;
}

export async function revokeToken(refreshTokenEnc: string): Promise<void> {
  await fetch(
    `${REVOKE_URL}?token=${encodeURIComponent(decrypt(refreshTokenEnc))}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    }
  ).catch(() => undefined);
}

function calUrl(calendarId: string, path = ''): string {
  return `${CAL}/calendars/${encodeURIComponent(calendarId)}/events${path}`;
}

/** Create or update our event (deterministic id → retries never duplicate). */
export async function upsertEvent(
  token: string,
  calendarId: string,
  body: Record<string, unknown>
): Promise<void> {
  const id = String(body.id);
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
  const patch = () =>
    fetch(calUrl(calendarId, `/${id}?sendUpdates=none`), {
      method: 'PATCH',
      headers,
      body: JSON.stringify(body),
    });

  let res = await patch();
  if (res.status === 404) {
    res = await fetch(calUrl(calendarId, '?sendUpdates=none'), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    // Created by a concurrent/earlier attempt, or deleted earlier (Google
    // keeps the id): patch it back.
    if (res.status === 409) res = await patch();
  }
  if (!res.ok) await fail(res);
}

export async function deleteEvent(
  token: string,
  calendarId: string,
  eventId: string
): Promise<void> {
  const res = await fetch(calUrl(calendarId, `/${eventId}?sendUpdates=none`), {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 404 || res.status === 410) return; // already gone
  if (!res.ok) await fail(res);
}

/** All event instances in a window (recurring ones expanded). */
export async function listEvents(
  token: string,
  calendarId: string,
  timeMin: Date,
  timeMax: Date
): Promise<unknown[]> {
  const out: unknown[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 10; page++) {
    const q = new URLSearchParams({
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      singleEvents: 'true',
      showDeleted: 'false',
      maxResults: '250',
    });
    if (pageToken) q.set('pageToken', pageToken);
    const res = await fetch(calUrl(calendarId, `?${q}`), {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) await fail(res);
    const j = (await res.json()) as {
      items?: unknown[];
      nextPageToken?: string;
    };
    out.push(...(j.items ?? []));
    if (!j.nextPageToken) break;
    pageToken = j.nextPageToken;
  }
  return out;
}
