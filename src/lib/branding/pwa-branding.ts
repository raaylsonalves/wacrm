// Server-only: account branding for the installed PWA (manifest name +
// icons). Looked up by account id from the URL — see ManifestBranding
// in src/lib/pwa.ts for why it can't come from the session.

import { supabaseAdmin } from '@/lib/flows/admin-client';
import { isUuid } from '@/lib/pwa';
import { safeLogoUrl } from '@/lib/branding/tab';
import { isValidHexColor } from '@/lib/color-contrast';
import { isDeliverableUrl } from '@/lib/webhooks/ssrf';

export interface AccountBranding {
  displayName: string | null;
  logoUrl: string | null;
  brandColor: string | null;
}

export async function loadAccountBranding(
  accountId: string | null | undefined
): Promise<AccountBranding | null> {
  if (!isUuid(accountId)) return null;
  const { data, error } = await supabaseAdmin()
    .from('accounts')
    .select('display_name, logo_url, brand_color')
    .eq('id', accountId)
    .maybeSingle();
  if (error || !data) return null;
  const color = data.brand_color?.trim() ?? null;
  return {
    displayName: data.display_name?.trim() || null,
    logoUrl: safeLogoUrl(data.logo_url),
    brandColor: color && isValidHexColor(color) ? color : null,
  };
}

/** Formats the icon renderer (satori) can decode. WebP/AVIF aren't. */
const RENDERABLE_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/svg+xml',
];
const MAX_LOGO_BYTES = 2 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 5000;

/**
 * Fetch the account logo and inline it as a data URL for rendering.
 * The URL is admin-supplied and fetched server-side, so it gets the
 * outbound-webhook SSRF guard. Returns null on anything unusable — the
 * caller falls back to the default mark.
 */
export async function fetchLogoDataUrl(url: string): Promise<string | null> {
  try {
    if (!(await isDeliverableUrl(url))) return null;
    const res = await fetch(url, {
      redirect: 'error',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const type = (res.headers.get('content-type') ?? '').split(';')[0].trim();
    if (!RENDERABLE_TYPES.includes(type)) return null;
    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared > MAX_LOGO_BYTES) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > MAX_LOGO_BYTES) return null;
    return `data:${type};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}
