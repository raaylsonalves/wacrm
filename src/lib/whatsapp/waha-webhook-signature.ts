import crypto from 'node:crypto';

/**
 * Verify the HMAC-SHA512 signature WAHA attaches to webhook POSTs
 * when a session is created with `config.webhooks[].hmac.key` set
 * (see `createWahaSession` in `waha-api.ts`). WAHA sends the digest
 * (hex) in the `X-Webhook-Hmac` header, matching the same
 * SHA512/timingSafeEqual shape the deskcomm WAHA doctrine documents.
 *
 * Unlike Meta's `META_APP_SECRET` (one global secret), the HMAC key
 * here is per-channel — `secret` is the decrypted
 * `whatsapp_waha_channels.webhook_secret` for the channel the caller
 * has already resolved (by session name) before calling this.
 */
export function verifyWahaWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
  secret: string
): boolean {
  if (!signatureHeader) return false;

  const expected = crypto
    .createHmac('sha512', secret)
    .update(rawBody)
    .digest('hex');

  const a = Buffer.from(signatureHeader);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
