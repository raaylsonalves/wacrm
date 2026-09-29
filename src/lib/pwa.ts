import type { MetadataRoute } from 'next';

// PWA helpers (specs/pwa-web-push-notifications.md). Pure where possible
// so the manifest shape and the push-key decoding are unit-tested.

export const PWA_ICON_VARIANTS = ['192', '512', 'maskable', 'apple'] as const;
export type PwaIconVariant = (typeof PWA_ICON_VARIANTS)[number];

/** Pixel size each icon variant renders at. */
export const PWA_ICON_SIZE: Record<PwaIconVariant, number> = {
  '192': 192,
  '512': 512,
  maskable: 512,
  apple: 180,
};

/** Mirrors `viewport.themeColor` in src/app/layout.tsx. */
export const PWA_THEME_COLOR = '#020617';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string | null | undefined): value is string {
  return !!value && UUID_RE.test(value);
}

/**
 * Per-account branding for the installed app. The browser fetches the
 * manifest and its icons WITHOUT the user's session cookies, so the
 * account is carried in the URL (`?a=`) instead; `v` busts caches when
 * the logo/color/name change.
 */
export interface ManifestBranding {
  accountId: string;
  name?: string | null;
  version?: string;
}

/** Query string the branded manifest/icons carry (empty = deploy brand). */
export function brandingQuery(branding?: ManifestBranding | null): string {
  if (!branding || !isUuid(branding.accountId)) return '';
  const params = new URLSearchParams({ a: branding.accountId });
  if (branding.version) params.set('v', branding.version);
  return `?${params.toString()}`;
}

/** Short, stable fingerprint of whatever the installed app displays. */
export function brandingVersion(parts: (string | null | undefined)[]): string {
  let h = 5381;
  for (const ch of parts.map((p) => p ?? '').join('|')) {
    h = ((h << 5) + h + ch.charCodeAt(0)) >>> 0;
  }
  return h.toString(36);
}

export function buildManifest(
  branding?: ManifestBranding | null
): MetadataRoute.Manifest {
  const name = branding?.name?.trim().slice(0, 45) || 'wacrm';
  const q = brandingQuery(branding);
  return {
    name,
    // Home-screen label: the OS truncates long names; 12 chars is the
    // commonly recommended ceiling.
    short_name: name.length > 12 ? name.slice(0, 12).trim() : name,
    description: 'WhatsApp CRM',
    // Same id for every account — it's the same app; only its look varies.
    id: '/dashboard',
    start_url: '/dashboard',
    scope: '/',
    display: 'standalone',
    background_color: PWA_THEME_COLOR,
    theme_color: PWA_THEME_COLOR,
    icons: [
      {
        src: `/pwa-icon/192${q}`,
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: `/pwa-icon/512${q}`,
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: `/pwa-icon/maskable${q}`,
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
