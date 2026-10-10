import { isValidHexColor } from '@/lib/color-contrast';

// Per-account browser-tab branding: title + favicon, applied after
// login from the account's display_name / logo_url / brand_color
// (Settings → Branding, migration 044). Pure so it's unit-tested.

/** Deploy-level name — what the tab says before login / without branding. */
export const DEFAULT_APP_NAME = 'wacrm';

/** First path segment → Sidebar translation key. */
const SECTION_KEYS: Record<string, string> = {
  dashboard: 'dashboard',
  inbox: 'inbox',
  analytics: 'analytics',
  notifications: 'notifications',
  contacts: 'contacts',
  pipelines: 'pipelines',
  agenda: 'agenda',
  agents: 'aiAgents',
  automations: 'automations',
  flows: 'flows',
  broadcasts: 'broadcasts',
  settings: 'settings',
};

export function sectionKeyForPath(pathname: string): string | null {
  const first = pathname.split('/').filter(Boolean)[0];
  return (first && SECTION_KEYS[first]) || null;
}

/** "Caixa de entrada — Clínica X", or just the brand on unknown paths. */
export function buildTabTitle(
  sectionLabel: string | null,
  brandName: string | null | undefined
): string {
  const brand = brandName?.trim() || DEFAULT_APP_NAME;
  return sectionLabel ? `${sectionLabel} — ${brand}` : brand;
}

/** Only http(s) URLs become a favicon — never data:/javascript: etc. */
export function safeLogoUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:'
      ? parsed.href
      : null;
  } catch {
    return null;
  }
}

/**
 * The default brand mark (same glyph as src/lib/brand-mark.tsx) as an
 * SVG data URL in the account's color. The color is validated as a
 * strict hex first, since it's interpolated into markup.
 */
export function brandMarkSvgDataUrl(rawColor: string): string | null {
  const color = rawColor.trim();
  if (!isValidHexColor(color)) return null;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">` +
    `<rect width="32" height="32" rx="6" fill="${color}"/>` +
    `<g transform="translate(6 6) scale(0.8333)" fill="none" stroke="#fff" ` +
    `stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">` +
    `<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>` +
    `</g></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** Logo wins; else the brand mark in the brand color; else null (keep default). */
export function faviconHrefForAccount(
  account: {
    logo_url?: string | null;
    brand_color?: string | null;
  } | null
): string | null {
  if (!account) return null;
  return (
    safeLogoUrl(account.logo_url) ??
    (account.brand_color ? brandMarkSvgDataUrl(account.brand_color) : null)
  );
}
