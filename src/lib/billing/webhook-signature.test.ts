import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  SIGNATURE_TOLERANCE_MS,
  identifyBillingSource,
  signatureManifest,
  verifyMercadoPagoSignature,
} from './webhook-signature';

const SECRET = 'test-secret';
const NOW = 1_781_009_491_000;

function sign(
  dataId: string | null,
  requestId: string | null,
  ts: number,
  secret = SECRET
) {
  const v1 = createHmac('sha256', secret)
    .update(signatureManifest(dataId, requestId, String(ts)))
    .digest('hex');
  return `ts=${ts},v1=${v1}`;
}

describe('signatureManifest', () => {
  it('lowercases the id and omits absent parts', () => {
    expect(signatureManifest('ABC123', 'req-1', '99')).toBe(
      'id:abc123;request-id:req-1;ts:99;'
    );
    expect(signatureManifest(null, null, '99')).toBe('ts:99;');
    expect(signatureManifest('', 'req-1', '99')).toBe(
      'request-id:req-1;ts:99;'
    );
  });
});

describe('verifyMercadoPagoSignature', () => {
  it('accepts a correct signature', () => {
    const r = verifyMercadoPagoSignature(
      {
        xSignature: sign('ORD01', 'req-1', NOW),
        xRequestId: 'req-1',
        dataId: 'ORD01',
        now: NOW,
      },
      SECRET
    );
    expect(r).toEqual({ ok: true, ts: NOW });
  });

  it('rejects a wrong secret', () => {
    const r = verifyMercadoPagoSignature(
      {
        xSignature: sign('ORD01', 'req-1', NOW, 'other'),
        xRequestId: 'req-1',
        dataId: 'ORD01',
        now: NOW,
      },
      SECRET
    );
    expect(r).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('rejects a tampered data id or request id', () => {
    const header = sign('ORD01', 'req-1', NOW);
    expect(
      verifyMercadoPagoSignature(
        { xSignature: header, xRequestId: 'req-1', dataId: 'ORD02', now: NOW },
        SECRET
      ).ok
    ).toBe(false);
    expect(
      verifyMercadoPagoSignature(
        { xSignature: header, xRequestId: 'req-2', dataId: 'ORD01', now: NOW },
        SECRET
      ).ok
    ).toBe(false);
  });

  it('rejects an old timestamp (replay) and a far-future one', () => {
    const old = NOW - SIGNATURE_TOLERANCE_MS - 1;
    expect(
      verifyMercadoPagoSignature(
        {
          xSignature: sign('x', 'r', old),
          xRequestId: 'r',
          dataId: 'x',
          now: NOW,
        },
        SECRET
      )
    ).toEqual({ ok: false, reason: 'stale' });
    const future = NOW + SIGNATURE_TOLERANCE_MS + 1;
    expect(
      verifyMercadoPagoSignature(
        {
          xSignature: sign('x', 'r', future),
          xRequestId: 'r',
          dataId: 'x',
          now: NOW,
        },
        SECRET
      ).ok
    ).toBe(false);
  });

  it('rejects missing or malformed headers', () => {
    for (const xSignature of [null, '', 'garbage', 'ts=abc,v1=zz', 'ts=1']) {
      expect(
        verifyMercadoPagoSignature(
          { xSignature, xRequestId: 'r', dataId: 'x', now: NOW },
          SECRET
        ).ok
      ).toBe(false);
    }
  });

  it('rejects a signature of the wrong length without throwing', () => {
    const r = verifyMercadoPagoSignature(
      {
        xSignature: `ts=${NOW},v1=abcd`,
        xRequestId: 'r',
        dataId: 'x',
        now: NOW,
      },
      SECRET
    );
    expect(r).toEqual({ ok: false, reason: 'mismatch' });
  });
});

describe('identifyBillingSource', () => {
  const input = (secret: string) => ({
    xSignature: sign('ORD01', 'req-1', NOW, secret),
    xRequestId: 'req-1',
    dataId: 'ORD01',
    now: NOW,
  });

  it('names the application whose secret signed it', () => {
    expect(
      identifyBillingSource(input('pix-secret'), {
        subs: 'subs-secret',
        pix: 'pix-secret',
      })
    ).toEqual({ source: 'pix', ts: NOW });
    expect(
      identifyBillingSource(input('subs-secret'), {
        subs: 'subs-secret',
        pix: 'pix-secret',
      })
    ).toEqual({ source: 'subs', ts: NOW });
  });

  it('accepts nothing when no secret is configured or none match', () => {
    expect(identifyBillingSource(input('x'), {})).toBeNull();
    expect(
      identifyBillingSource(input('x'), { subs: 'a', pix: 'b' })
    ).toBeNull();
  });
});
