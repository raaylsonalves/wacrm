import { describe, it, expect } from 'vitest';
import {
  PWA_ICON_VARIANTS,
  buildManifest,
  detectPushSupport,
  isIosDevice,
  urlBase64ToUint8Array,
} from './pwa';

describe('buildManifest', () => {
  const m = buildManifest();

  it('is installable: standalone, start_url, name', () => {
    expect(m.display).toBe('standalone');
    expect(m.start_url).toBe('/dashboard');
    expect(m.name).toBeTruthy();
  });

  it('ships 192 + 512 icons and a maskable one', () => {
    const sizes = (m.icons ?? []).map((i) => `${i.sizes}:${i.purpose}`);
    expect(sizes).toEqual(
      expect.arrayContaining(['192x192:any', '512x512:any', '512x512:maskable'])
    );
  });

  it('only references icon variants the /pwa-icon route serves', () => {
    for (const icon of m.icons ?? []) {
      const variant = icon.src.replace('/pwa-icon/', '');
      expect(PWA_ICON_VARIANTS as readonly string[]).toContain(variant);
    }
  });
});

describe('urlBase64ToUint8Array', () => {
  it('decodes URL-safe base64 without padding', () => {
    // bytes 0xfb 0xff -> standard "+/8=" -> url-safe "-_8"
    expect(Array.from(urlBase64ToUint8Array('-_8'))).toEqual([0xfb, 0xff]);
  });
});

describe('isIosDevice', () => {
  it('detects iPhone and touch-Mac (iPadOS) UAs', () => {
    expect(
      isIosDevice('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)')
    ).toBe(true);
    expect(
      isIosDevice('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 5)
    ).toBe(true);
    expect(
      isIosDevice('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 0)
    ).toBe(false);
    expect(isIosDevice('Mozilla/5.0 (Linux; Android 14)')).toBe(false);
  });
});

describe('detectPushSupport', () => {
  it('supported when SW + PushManager exist', () => {
    expect(
      detectPushSupport({
        hasServiceWorker: true,
        hasPushManager: true,
        isIos: true,
        isStandalone: true,
      })
    ).toBe('supported');
  });
  it('iOS in a Safari tab needs Add to Home Screen first', () => {
    expect(
      detectPushSupport({
        hasServiceWorker: true,
        hasPushManager: false,
        isIos: true,
        isStandalone: false,
      })
    ).toBe('ios-needs-install');
  });
  it('otherwise unsupported', () => {
    expect(
      detectPushSupport({
        hasServiceWorker: false,
        hasPushManager: false,
        isIos: false,
        isStandalone: false,
      })
    ).toBe('unsupported');
  });
});
