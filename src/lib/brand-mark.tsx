import { ImageResponse } from 'next/og';

// The brand mark — violet rounded square + white chat-square glyph,
// matching the sidebar logo — rendered at any size. Shared by the
// favicon (src/app/icon.tsx), the iOS home-screen icon
// (src/app/apple-icon.tsx) and the PWA manifest icons
// (src/app/pwa-icon/[size]/route.tsx) so they can't drift apart.

export const BRAND_PURPLE = '#7c3aed';

export function brandMarkResponse(
  size: number,
  opts: { maskable?: boolean; headers?: HeadersInit; color?: string } = {}
): ImageResponse {
  // Maskable: the OS crops to its own shape (circle, squircle…), and only
  // the central 80% "safe zone" is guaranteed visible — so fill the whole
  // canvas with no corner radius and shrink the glyph into that zone.
  const glyph = Math.round(size * (opts.maskable ? 0.45 : 0.625));
  const radius = opts.maskable ? 0 : Math.round(size * 0.1875);

  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: opts.color ?? BRAND_PURPLE,
        borderRadius: radius,
      }}
    >
      <svg
        width={glyph}
        height={glyph}
        viewBox="0 0 24 24"
        fill="none"
        stroke="#ffffff"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
    </div>,
    { width: size, height: size, headers: opts.headers }
  );
}

/**
 * An account logo (already inlined as a data URL) centered on a solid
 * square, for the installed app's icon. Logos come in any aspect ratio,
 * so it's contained within a padded box rather than stretched; maskable
 * variants pad further so the OS's crop never clips it.
 */
export function logoIconResponse(
  size: number,
  logoDataUrl: string,
  opts: { maskable?: boolean; headers?: HeadersInit; background?: string } = {}
): ImageResponse {
  const box = Math.round(size * (opts.maskable ? 0.6 : 0.8));
  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: opts.background ?? '#ffffff',
      }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- rendered by satori into a PNG, not the DOM */}
      <img
        src={logoDataUrl}
        alt=""
        width={box}
        height={box}
        style={{ objectFit: 'contain' }}
      />
    </div>,
    { width: size, height: size, headers: opts.headers }
  );
}
