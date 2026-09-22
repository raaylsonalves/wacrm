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
  const res = await fetch(url, {
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

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new WahaApiError(
      `WAHA request failed (${res.status}): ${text.slice(0, 500)}`,
      res.status
    );
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
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
        webhooks: [
          {
            url: webhookUrl,
            events: ['message', 'session.status'],
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
 * WAHA's `/auth/qr` endpoint answers with `{ mimetype, data }` where
 * `data` is already base64. Only valid while the session is in
 * SCAN_QR_CODE — a STOPPED session (never started, or WAHA restarted
 * and dropped it) 422s here, so the caller starts it first and
 * retries once rather than surfacing that as a hard failure.
 */
export async function getWahaQrCode(
  baseUrl: string,
  apiKey: string,
  sessionName: string
): Promise<string> {
  const fetchQr = () =>
    wahaFetch<{ mimetype: string; data: string }>(
      baseUrl,
      apiKey,
      `/api/${encodeURIComponent(sessionName)}/auth/qr`
    );

  try {
    const result = await fetchQr();
    return `data:${result.mimetype};base64,${result.data}`;
  } catch (err) {
    if (!(err instanceof WahaApiError) || err.status !== 422) throw err;
    await startWahaSession(baseUrl, apiKey, sessionName);
    const result = await fetchQr();
    return `data:${result.mimetype};base64,${result.data}`;
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
  return wahaFetch<WahaSendTextResult>(baseUrl, apiKey, '/api/sendText', {
    method: 'POST',
    body: { session: sessionName, chatId, text },
  });
}

/**
 * WAHA/NOWEB chat id for a phone number: digits only, `@c.us` suffix.
 * Mirrors the shape Meta's own `normalizePhone` produces, so any
 * caller that already has a normalized phone can pass it straight
 * through.
 */
export function toWahaChatId(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  return `${digits}@c.us`;
}

/** Inverse of `toWahaChatId` — strips the `@c.us`/`@g.us` suffix. */
export function fromWahaChatId(chatId: string): string {
  return chatId.replace(/@(c|g)\.us$/, '');
}
