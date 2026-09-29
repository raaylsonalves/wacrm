import { brandMarkResponse } from '@/lib/brand-mark';
import { PWA_ICON_VARIANTS, type PwaIconVariant } from '@/lib/pwa';

// GET /pwa-icon/{192|512|maskable} — the manifest's icons, and the
// icon/badge the service worker shows on push notifications.

export const runtime = 'edge';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ size: string }> }
) {
  const { size } = await params;
  if (!(PWA_ICON_VARIANTS as readonly string[]).includes(size)) {
    return new Response('Not found', { status: 404 });
  }
  const variant = size as PwaIconVariant;
  return brandMarkResponse(variant === 'maskable' ? 512 : Number(variant), {
    maskable: variant === 'maskable',
    headers: { 'Cache-Control': 'public, max-age=86400' },
  });
}
