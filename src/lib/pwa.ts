import type { MetadataRoute } from 'next';

// PWA helpers (specs/pwa-web-push-notifications.md). Pure where possible
// so the manifest shape and the push-key decoding are unit-tested.

export const PWA_ICON_VARIANTS = ['192', '512', 'maskable'] as const;
export type PwaIconVariant = (typeof PWA_ICON_VARIANTS)[number];

/** Mirrors `viewport.themeColor` in src/app/layout.tsx. */
export const PWA_THEME_COLOR = '#020617';

export function buildManifest(): MetadataRoute.Manifest {
  return {
    name: 'wacrm',
    short_name: 'wacrm',
    description: 'WhatsApp CRM',
    id: '/dashboard',
    start_url: '/dashboard',
    scope: '/',
    display: 'standalone',
    background_color: PWA_THEME_COLOR,
    theme_color: PWA_THEME_COLOR,
    icons: [
      {
        src: '/pwa-icon/192',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/pwa-icon/512',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/pwa-icon/maskable',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
  };
}

/** VAPID public keys are URL-safe base64; PushManager wants raw bytes. */
export function urlBase64ToUint8Array(
  base64String: string
): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/**
 * iPhone/iPad Safari. iPadOS 13+ reports itself as "Macintosh", so a
 * touch-capable Mac UA counts as iOS too.
 */
export function isIosDevice(userAgent: string, maxTouchPoints = 0): boolean {
  if (/iPad|iPhone|iPod/.test(userAgent)) return true;
  return /Macintosh/.test(userAgent) && maxTouchPoints > 1;
}

export type PushSupport =
  | 'supported'
  /** iOS in a regular Safari tab — must "Add to Home Screen" first. */
  | 'ios-needs-install'
  | 'unsupported';

export function detectPushSupport(env: {
  hasServiceWorker: boolean;
  hasPushManager: boolean;
  isIos: boolean;
  isStandalone: boolean;
}): PushSupport {
  if (env.hasServiceWorker && env.hasPushManager) return 'supported';
  // iOS only exposes PushManager to an installed home-screen app.
  if (env.isIos && !env.isStandalone) return 'ios-needs-install';
  return 'unsupported';
}
