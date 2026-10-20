/**
 * Thin HTTP client for a self-hosted WAHA instance
 * (https://waha.devlike.pro), the first slice of
 * `specs/waha-channel-connection.md`.
 *
 * Unlike `meta-api.ts`, there is no long-running process for wacrm to
 * manage here — WAHA itself is that process, running on the user's own
 * VPS. Every function below is a single HTTP call; session state
 * (auth, connectivity) lives entirely in WAHA, not in wacrm.
 *
 * `baseUrl` and `apiKey` are per-channel (decrypted by the caller from
 * `whatsapp_waha_channels`), never a global env var — a self-hoster can
 * point different channels at different WAHA instances.
 */

export class WahaApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = 'WahaApiError';
  }
}

interface WahaRequestOptions {
  method?: string;
  body?: unknown;
}

async function wahaFetch<T>(
  baseUrl: string,
  apiKey: string,
  path: string,
  { method = 'GET', body }: WahaRequestOptions = {}
): Promise<T> {
  const url = new URL(path, baseUrl).toString();
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        'X-Api-Key': apiKey,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      // WAHA runs on infrastructure the caller controls, but a hung
      // connect-flow request (bad URL, firewalled port) shouldn't hang
      // the API route indefinitely.
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    // DNS failure, connection refused, or the 15s timeout above
    // (AbortError) — normalized to WahaApiError so every caller's
    // `err instanceof WahaApiError` check catches it, instead of
    // silently falling through to a message-less generic string.
    const message = err instanceof Error ? err.message : String(err);
    throw new WahaApiError(`Could not reach WAHA: ${message}`, 0);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new WahaApiError(
      `WAHA request failed (${res.status}): ${text.slice(0, 500)}`,
      res.status
    );
  }
  if (res.status === 204) return undefined as T;
  // A handful of WAHA's action endpoints (observed: POST .../stop, 201)
  // answer 2xx with an EMPTY body rather than 204 — not a proxy error,
  // just that endpoint's own contract. An empty body on a 2xx is a
  // no-op success, not a parse failure: treat it the same as 204 rather
  // than throwing, which would make every stop/logout call fail even
  // though the action itself succeeded.
  const text = await res.text();
  if (text === '') return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    // A 2xx with a non-empty, non-JSON body — e.g. a reverse proxy in
    // front of the WAHA instance answering with an HTML error page
    // instead of proxying through. Same normalization as above.
    throw new WahaApiError(
      `WAHA returned a non-JSON response (status ${res.status})`,
      res.status
    );
  }
}

export type WahaSessionStatus =
  'STARTING' | 'SCAN_QR_CODE' | 'WORKING' | 'FAILED' | 'STOPPED';

export interface WahaSession {
  name: string;
  status: WahaSessionStatus;
}

/**
 * Creates (or restarts, if it already exists — WAHA's own semantics)
 * a session configured to push events to our webhook, HMAC-signed with
 * `webhookSecret` so `verifyWahaWebhookSignature` can authenticate the
 * callback later.
 */
export async function createWahaSession(
  baseUrl: string,
  apiKey: string,
  sessionName: string,
  webhookUrl: string,
  webhookSecret: string
): Promise<WahaSession> {
  return wahaFetch<WahaSession>(baseUrl, apiKey, '/api/sessions', {
    method: 'POST',
    body: {
      name: sessionName,
      config: {
        // The NOWEB store lets /lids/{lid} map a privacy id back to the
        // customer's number (resolveWahaLid). Ignored by other engines.
        noweb: { store: { enabled: true, full_sync: false } },
        webhooks: [
          {
            url: webhookUrl,
            // message.any also carries what the number itself sends, so a
            // reply typed on the phone reaches the inbox (and pauses the AI).
            events: ['message.any', 'session.status'],
            hmac: { key: webhookSecret },
          },
        ],
      },
    },
  });
}

export async function getWahaSessionStatus(
  baseUrl: string,
  apiKey: string,
  sessionName: string
): Promise<WahaSession> {
  return wahaFetch<WahaSession>(
    baseUrl,
    apiKey,
    `/api/sessions/${encodeURIComponent(sessionName)}`
  );
}

/**
 * WAHA creates a session STOPPED — it does not auto-start it (some
 * versions/configs do, but not reliably enough to assume). Every
 * caller that wants a scannable session must start it explicitly
 * afterwards; a session already starting/started answers 422/409,
 * which the caller can treat as a no-op.
 */
export async function startWahaSession(
  baseUrl: string,
  apiKey: string,
  sessionName: string
): Promise<WahaSession> {
  return wahaFetch<WahaSession>(
    baseUrl,
    apiKey,
    `/api/sessions/${encodeURIComponent(sessionName)}/start`,
    { method: 'POST' }
  );
}

/**
 * Returns a data: URI (base64 PNG) ready to drop into an <img> tag.
 *
 * WAHA's `/auth/qr` endpoint answers with the raw PNG bytes
 * (`Content-Type: image/png`) — NOT the `{ mimetype, data }` JSON
 * envelope some WAHA docs/versions describe. deskcomm's own QR route
 * (`app/api/v1/channel-sessions/[id]/qr/route.ts`) already treats it
 * this way, proxying the bytes straight through; this used to go
 * through `wahaFetch`, which unconditionally called `res.json()` and
 * threw "non-JSON response" on every single QR fetch, healthy session
 * or not — this was failing even right after a fresh, successful
 * session create, nothing to do with the FAILED-session race below.
 *
 * Only valid while the session is in SCAN_QR_CODE.
 *
 * A 422 here has two different causes with different fixes — conflating
 * them is what used to make this 502 for good after the QR expired:
 *
 *  - STOPPED (never started, or WAHA restarted and dropped it): a plain
 *    `start` is enough, the paired-device credential (if any) is still
 *    good.
 *  - FAILED (WAHA's own NOWEB/Baileys engine gives up generating the QR
 *    after ~60s unscanned and force-stops the session — see WAHA's logs
 *    for "QR refs attempts ended"): `start` alone reuses the now-dead
 *    QR-pairing state and goes straight back to FAILED without ever
 *    passing through SCAN_QR_CODE again. It needs `logout` first, to
 *    discard that state — same fix deskcomm's own reconnect route
 *    applies (`stop` → `logout` → `start`) for the analogous case of a
 *    revoked credential.
 */
async function fetchQrImage(
  baseUrl: string,
  apiKey: string,
  sessionName: string
): Promise<string> {
  const url = new URL(
    `/api/${encodeURIComponent(sessionName)}/auth/qr`,
    baseUrl
  ).toString();
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { 'X-Api-Key': apiKey },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new WahaApiError(`Could not reach WAHA: ${message}`, 0);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new WahaApiError(
      `WAHA request failed (${res.status}): ${text.slice(0, 500)}`,
      res.status
    );
  }
  const mimetype = res.headers.get('content-type') ?? 'image/png';
  const bytes = Buffer.from(await res.arrayBuffer());
  return `data:${mimetype};base64,${bytes.toString('base64')}`;
}

export async function getWahaQrCode(
  baseUrl: string,
  apiKey: string,
  sessionName: string
): Promise<string> {
  try {
    return await fetchQrImage(baseUrl, apiKey, sessionName);
  } catch (err) {
    if (!(err instanceof WahaApiError) || err.status !== 422) throw err;

    const session = await wahaFetch<WahaSession>(
      baseUrl,
      apiKey,
      `/api/sessions/${encodeURIComponent(sessionName)}`
    ).catch(() => null);

    if (session?.status === 'FAILED') {
      await stopWahaSession(baseUrl, apiKey, sessionName).catch(() => {});
      await logoutWahaSession(baseUrl, apiKey, sessionName).catch(() => {});
    }
    await startWahaSession(baseUrl, apiKey, sessionName);
    return fetchQrImage(baseUrl, apiKey, sessionName);
  }
}

/**
 * Requests a pairing code (WAHA's alternative to scanning a QR — the
 * user types this into WhatsApp on their phone instead) for the given
 * phone number. WAHA expects the number in international format
 * without a leading `+` or spaces; the caller normalizes.
 */
export async function requestWahaPairingCode(
  baseUrl: string,
  apiKey: string,
  sessionName: string,
  phoneNumber: string
): Promise<string> {
  const result = await wahaFetch<{ code: string }>(
    baseUrl,
    apiKey,
    `/api/${encodeURIComponent(sessionName)}/auth/request-code`,
    { method: 'POST', body: { phoneNumber } }
  );
  return result.code;
}

export async function deleteWahaSession(
  baseUrl: string,
  apiKey: string,
  sessionName: string
): Promise<void> {
  await wahaFetch<void>(
    baseUrl,
    apiKey,
    `/api/sessions/${encodeURIComponent(sessionName)}`,
    { method: 'DELETE' }
  );
}

export async function stopWahaSession(
  baseUrl: string,
  apiKey: string,
  sessionName: string
): Promise<void> {
  await wahaFetch<void>(
    baseUrl,
    apiKey,
    `/api/sessions/${encodeURIComponent(sessionName)}/stop`,
    { method: 'POST' }
  );
}

/**
 * Discards the paired device's credential without touching the
 * session's config (webhook, HMAC secret, ignore filters) — unlike
 * `deleteWahaSession`, which would also require recreating those.
 * Needed because a plain `startWahaSession` on a FAILED session
 * reuses the dead credential and goes straight back to FAILED
 * without ever passing through SCAN_QR_CODE again.
 */
export async function logoutWahaSession(
  baseUrl: string,
  apiKey: string,
  sessionName: string
): Promise<void> {
  await wahaFetch<void>(
    baseUrl,
    apiKey,
    `/api/sessions/${encodeURIComponent(sessionName)}/logout`,
    { method: 'POST' }
  );
}

export interface WahaSendTextResult {
  id: string;
}

export async function sendWahaText(
  baseUrl: string,
  apiKey: string,
  sessionName: string,
  chatId: string,
  text: string
): Promise<WahaSendTextResult> {
  const r = await wahaFetch<WahaSendResponse>(
    baseUrl,
    apiKey,
    '/api/sendText',
    {
      method: 'POST',
      body: { session: sessionName, chatId, text },
    }
  );
  return { id: wahaMessageId(r) };
}

/** "Seen" + "typing…" in the customer's chat while the reply is written. */
export async function startWahaTyping(
  baseUrl: string,
  apiKey: string,
  sessionName: string,
  chatId: string
): Promise<void> {
  const body = { session: sessionName, chatId };
  await wahaFetch(baseUrl, apiKey, '/api/sendSeen', { method: 'POST', body });
  await wahaFetch(baseUrl, apiKey, '/api/startTyping', { method: 'POST', body });
}

/** What WAHA answers to a send: WEBJS `{ id }`, NOWEB `{ key: { id } }`. */
type WahaSendResponse = {
  id?: string | { id?: string; _serialized?: string };
  key?: { id?: string };
} | null;

/** The sent message's id, whatever the engine. Empty when absent. */
export function wahaMessageId(r: WahaSendResponse): string {
  if (typeof r?.id === 'string') return r.id;
  return r?.key?.id ?? r?.id?._serialized ?? r?.id?.id ?? '';
}

const WAHA_MEDIA_ENDPOINT = {
  image: '/api/sendImage',
  video: '/api/sendVideo',
  audio: '/api/sendVoice',
  document: '/api/sendFile',
} as const;

/** An image / video / voice note / document by public URL, with caption. */
export async function sendWahaMedia(
  baseUrl: string,
  apiKey: string,
  sessionName: string,
  chatId: string,
  media: {
    kind: keyof typeof WAHA_MEDIA_ENDPOINT;
    url: string;
    mimetype?: string;
    filename?: string;
    caption?: string;
  }
): Promise<WahaSendTextResult> {
  const r = await wahaFetch<WahaSendResponse>(
    baseUrl,
    apiKey,
    WAHA_MEDIA_ENDPOINT[media.kind],
    {
      method: 'POST',
      body: {
        session: sessionName,
        chatId,
        file: {
          url: media.url,
          ...(media.mimetype ? { mimetype: media.mimetype } : {}),
          ...(media.filename ? { filename: media.filename } : {}),
        },
        ...(media.caption ? { caption: media.caption } : {}),
      },
    }
  );
  return { id: wahaMessageId(r) };
}

/**
 * WAHA/NOWEB chat id for a phone number: digits only, `@c.us` suffix.
 * Mirrors the shape Meta's own `normalizePhone` produces, so any
 * caller that already has a normalized phone can pass it straight
 * through.
 */
export function toWahaChatId(phone: string): string {
  // A privacy id we could not turn into a number is already a chat id.
  if (phone.endsWith('@lid')) return phone;
  const digits = phone.replace(/\D/g, '');
  return `${digits}@c.us`;
}

/**
 * WAHA reports media at its own internal address
 * (`http://localhost:3000/api/files/...`, from the server's
 * WHATSAPP_API_HOSTNAME), which nothing outside its container can reach.
 * Same path, on the channel's public base URL.
 */
export function wahaMediaUrl(rawUrl: string, baseUrl: string): string {
  try {
    const u = new URL(rawUrl);
    const base = new URL(baseUrl);
    if (u.host === base.host) return rawUrl;
    return new URL(u.pathname + u.search, base).toString();
  } catch {
    return rawUrl;
  }
}

/** A WAHA media file's bytes (the API key is required). */
export async function downloadWahaMedia(
  url: string,
  apiKey: string
): Promise<{ buffer: Buffer; contentType: string }> {
  const res = await fetch(url, {
    headers: { 'X-Api-Key': apiKey },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new WahaApiError(`WAHA media download failed`, res.status);
  return {
    buffer: Buffer.from(await res.arrayBuffer()),
    contentType: res.headers.get('content-type') || 'application/octet-stream',
  };
}

/**
 * The customer's number when WAHA's message carries it next to a privacy
 * id: NOWEB puts it in `_data.key.remoteJidAlt` / `senderPn`
 * ("5585…@s.whatsapp.net"). Null when absent.
 */
export function phoneFromWahaAlt(payload: {
  _data?: { key?: Record<string, unknown> } | null;
}): string | null {
  const key = payload._data?.key ?? {};
  for (const field of ['remoteJidAlt', 'senderPn', 'participantAlt']) {
    const v = key[field];
    if (typeof v !== 'string' || v.endsWith('@lid')) continue;
    const digits = v.replace(/@.*$/, '').replace(/:.*$/, '').replace(/\D/g, '');
    if (digits.length >= 10) return digits;
  }
  return null;
}

/**
 * The phone number behind a WhatsApp privacy id (`123…@lid`), or null when
 * WAHA does not know it yet. Newer WhatsApp versions hide the customer's
 * number behind a LID; replying to `<lid digits>@c.us` reaches nobody.
 */
export async function resolveWahaLid(
  baseUrl: string,
  apiKey: string,
  sessionName: string,
  lid: string
): Promise<string | null> {
  const body = await wahaFetch<{ pn?: string | null } | null>(
    baseUrl,
    apiKey,
    `/api/${encodeURIComponent(sessionName)}/lids/${encodeURIComponent(lid)}`
  );
  const digits = body?.pn?.replace(/@.*$/, '').replace(/\D/g, '') ?? '';
  return digits.length >= 10 ? digits : null;
}

/** Inverse of `toWahaChatId` — strips the `@c.us`/`@g.us` suffix. */
export function fromWahaChatId(chatId: string): string {
  return chatId.replace(/@(c|g)\.us$/, '');
}

/**
 * The contact's WhatsApp profile picture URL, or null when there is none
 * (no photo, or privacy settings hide it — a normal state, not an error).
 * The URL is a signed WhatsApp CDN link that expires in days: callers must
 * store the FILE, never this URL.
 */
export async function getWahaProfilePictureUrl(
  baseUrl: string,
  apiKey: string,
  sessionName: string,
  chatId: string
): Promise<string | null> {
  const body = await wahaFetch<{ profilePictureURL?: string | null } | null>(
    baseUrl,
    apiKey,
    `/api/contacts/profile-picture?contactId=${encodeURIComponent(chatId)}&session=${encodeURIComponent(sessionName)}`
  );
  return body?.profilePictureURL ?? null;
}
