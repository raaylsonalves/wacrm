// ============================================================
// GET /api/pwa/manifest?a=<accountId>&v=<version>
//
// The installed app's manifest in a specific account's branding (name
// + icons). The dashboard points <link rel="manifest"> here after login
// (AccountTabBranding); the static /manifest.webmanifest stays the
// deploy-level default for signed-out pages.
//
// Carries the account in the URL because browsers fetch manifests
// without session cookies. It exposes only the display name and logo
// — the account's public face — never anything behind RLS. An unknown
// or missing id just yields the default manifest.
// ============================================================

import { loadAccountBranding } from '@/lib/branding/pwa-branding';
import { brandingVersion, buildManifest } from '@/lib/pwa';

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const accountId = params.get('a');
  const branding = await loadAccountBranding(accountId);

  const manifest = buildManifest(
    branding && accountId
      ? {
          accountId,
          name: branding.displayName,
          version: brandingVersion([
            branding.displayName,
            branding.logoUrl,
            branding.brandColor,
          ]),
        }
      : null
  );

  return new Response(JSON.stringify(manifest), {
    headers: { 'Content-Type': 'application/manifest+json; charset=utf-8' },
  });
}
