import {
  badgeResponse,
  brandMarkResponse,
  logoIconResponse,
} from '@/lib/brand-mark';
import {
  fetchLogoDataUrl,
  loadAccountBranding,
} from '@/lib/branding/pwa-branding';
import {
  PWA_ICON_SIZE,
  PWA_ICON_VARIANTS,
  type PwaIconVariant,
} from '@/lib/pwa';

// GET /pwa-icon/{192|512|maskable|apple}[?a=<accountId>&v=<version>]
//
// Without `a`: the deploy-level brand mark. With `a`: that account's
// logo (or the mark in its brand color), for the installed app — see
// ManifestBranding in src/lib/pwa.ts for why the account travels in the
// URL. `v` changes whenever the branding does, so a long cache is safe.
//
// Node runtime (not edge): it reads the account via the service role
// and fetches the logo server-side.

export async function GET(
  request: Request,
  { params }: { params: Promise<{ size: string }> }
) {
  const { size } = await params;
  if (!(PWA_ICON_VARIANTS as readonly string[]).includes(size)) {
    return new Response('Not found', { status: 404 });
  }
  const variant = size as PwaIconVariant;
  const px = PWA_ICON_SIZE[variant];
  // Apple applies its own rounded mask, so treat it like maskable: no
  // corner radius, glyph/logo kept inside the safe zone.
  const maskable = variant === 'maskable' || variant === 'apple';
  const headers = { 'Cache-Control': 'public, max-age=86400' };

  // The badge is a shape mask, so a logo can't work there — same glyph
  // for every account.
  if (variant === 'badge') return badgeResponse(px, headers);

  const accountId = new URL(request.url).searchParams.get('a');
  const branding = await loadAccountBranding(accountId);

  if (branding?.logoUrl) {
    const logo = await fetchLogoDataUrl(branding.logoUrl);
    if (logo) {
      try {
        return logoIconResponse(px, logo, { maskable, headers });
      } catch {
        // Undecodable image — fall through to the brand mark.
      }
    }
  }

  return brandMarkResponse(px, {
    maskable,
    headers,
    color: branding?.brandColor ?? undefined,
  });
}
