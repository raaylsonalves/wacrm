import crypto from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { verifyWahaWebhookSignature } from './waha-webhook-signature';

function sign(body: string, secret: string): string {
  return crypto.createHmac('sha512', secret).update(body).digest('hex');
}

describe('verifyWahaWebhookSignature', () => {
  const secret = 'test-channel-secret';
  const body = JSON.stringify({ event: 'message', session: 'wacrm-abc' });

  it('accepts a correctly signed body', () => {
    expect(verifyWahaWebhookSignature(body, sign(body, secret), secret)).toBe(
      true
    );
  });

  it('rejects a wrong secret', () => {
    expect(
      verifyWahaWebhookSignature(body, sign(body, 'wrong-secret'), secret)
    ).toBe(false);
  });

  it('rejects a tampered body', () => {
    const tampered = JSON.stringify({ event: 'message', session: 'evil' });
    expect(
      verifyWahaWebhookSignature(tampered, sign(body, secret), secret)
    ).toBe(false);
  });

  it('rejects a missing header', () => {
    expect(verifyWahaWebhookSignature(body, null, secret)).toBe(false);
  });

  it('rejects a header of different length without throwing', () => {
    expect(verifyWahaWebhookSignature(body, 'short', secret)).toBe(false);
  });
});
