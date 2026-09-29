import { describe, it, expect } from 'vitest';
import {
  PWA_ICON_VARIANTS,
  brandingQuery,
  brandingVersion,
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

describe('per-account manifest', () => {
  const id = '3f1c2b4a-1d2e-4f5a-8b9c-0d1e2f3a4b5c';

  it('uses the account name and points icons at that account', () => {
    const m = buildManifest({
      accountId: id,
      name: 'Clínica X',
      version: 'v1',
    });
    expect(m.name).toBe('Clínica X');
    expect(m.short_name).toBe('Clínica X');
    for (const icon of m.icons ?? []) {
      expect(icon.src).toContain(`a=${id}`);
      expect(icon.src).toContain('v=v1');
    }
    // Same app identity regardless of account.
    expect(m.id).toBe('/dashboard');
  });

  it('shortens a long name for the home-screen label', () => {
    const m = buildManifest({
      accountId: id,
      name: 'Clínica Odontológica Sorriso',
    });
    expect(m.name).toBe('Clínica Odontológica Sorriso');
    expect((m.short_name ?? '').length).toBeLessThanOrEqual(12);
  });

  it('ignores a non-uuid account id (no query injection)', () => {
    expect(brandingQuery({ accountId: 'x&a=evil' })).toBe('');
    const m = buildManifest({ accountId: '../../etc', name: 'X' });
    expect((m.icons ?? [])[0].src).toBe('/pwa-icon/192');
  });

  it('brandingVersion changes when the branding does', () => {
    const a = brandingVersion(['X', 'https://l/1.png', '#000000']);
    expect(brandingVersion(['X', 'https://l/1.png', '#000000'])).toBe(a);
    expect(brandingVersion(['X', 'https://l/2.png', '#000000'])).not.toBe(a);
  });
});
