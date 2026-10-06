// Mercado Pago webhook authenticity (docs: "Validar a origem da
// notificação"). The `x-signature` header is `ts=<ms>,v1=<hex>`; v1 is an
// HMAC-SHA256, keyed with the application's secret, over the manifest
//   id:<data.id from the URL, lowercased>;request-id:<x-request-id>;ts:<ts>;
// where any part that is absent is left out of the manifest.
//
// Two applications (subscriptions and Pix) each have their own secret, so
// the caller passes the candidate secrets and learns which one signed.

import { createHmac, timingSafeEqual } from 'node:crypto';

/** How far the signed timestamp may be from now (replay protection). */
export const SIGNATURE_TOLERANCE_MS = 5 * 60_000;

export interface SignatureInput {
  xSignature: string | null;
  xRequestId: string | null;
  /** `data.id` query parameter of the notification URL. */
  dataId: string | null;
  now?: number;
}

export type SignatureResult =
  | { ok: true; ts: number }
  | { ok: false; reason: 'malformed' | 'stale' | 'mismatch' };

function parseSignature(header: string | null) {
  let ts: string | undefined;
  let v1: string | undefined;
  for (const part of (header ?? '').split(',')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const val = part.slice(eq + 1).trim();
    if (key === 'ts') ts = val;
    if (key === 'v1') v1 = val;
  }
  return { ts, v1 };
}

export function signatureManifest(
  dataId: string | null,
  requestId: string | null,
  ts: string
): string {
  const parts: string[] = [];
  const id = (dataId ?? '').toLowerCase();
  if (id) parts.push(`id:${id}`);
  if (requestId) parts.push(`request-id:${requestId}`);
  parts.push(`ts:${ts}`);
  return parts.join(';') + ';';
}

export function verifyMercadoPagoSignature(
  input: SignatureInput,
  secret: string
): SignatureResult {
  const { ts, v1 } = parseSignature(input.xSignature);
  if (!ts || !v1 || !/^\d+$/.test(ts) || !/^[0-9a-f]+$/i.test(v1)) {
    return { ok: false, reason: 'malformed' };
  }
  const tsMs = Number(ts);
  const now = input.now ?? Date.now();
  if (Math.abs(now - tsMs) > SIGNATURE_TOLERANCE_MS) {
    return { ok: false, reason: 'stale' };
  }
  const computed = createHmac('sha256', secret)
    .update(signatureManifest(input.dataId, input.xRequestId, ts))
    .digest('hex');
  const a = Buffer.from(computed, 'utf8');
  const b = Buffer.from(v1.toLowerCase(), 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: 'mismatch' };
  }
  return { ok: true, ts: tsMs };
}

export type BillingSource = 'subs' | 'pix';

/**
 * Which application signed the notification: tries each configured
 * secret. Returns null when none match (or none are configured), so an
 * unconfigured deployment accepts nothing.
 */
export function identifyBillingSource(
  input: SignatureInput,
  secrets: Partial<Record<BillingSource, string | undefined>>
): { source: BillingSource; ts: number } | null {
  for (const source of ['subs', 'pix'] as const) {
    const secret = secrets[source];
    if (!secret) continue;
    const r = verifyMercadoPagoSignature(input, secret);
    if (r.ok) return { source, ts: r.ts };
  }
  return null;
}
