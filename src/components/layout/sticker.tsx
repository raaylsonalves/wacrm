import type { CSSProperties } from 'react';

export type StickerKind =
  | 'conversa'
  | 'enviado'
  | 'agenda'
  | 'crescimento'
  | 'ia'
  | 'ganho'
  | 'contato'
  | 'notificacao';

type Shape = 'square' | 'circle' | 'seal';

// Shape + pastel swatch per sticker. Swatches are fixed (not theme
// tokens) on purpose: a sticker keeps its colour on light and dark
// backgrounds, like a real one would — the white die-cut border is what
// separates it from either surface.
const META: Record<StickerKind, { shape: Shape; fill: string }> = {
  conversa: { shape: 'square', fill: '#cdb8f6' },
  enviado: { shape: 'circle', fill: '#bfe6d2' },
  agenda: { shape: 'square', fill: '#f7ad90' },
  crescimento: { shape: 'square', fill: '#adc6f0' },
  ia: { shape: 'circle', fill: '#cdb8f6' },
  ganho: { shape: 'seal', fill: '#bfe6d2' },
  contato: { shape: 'circle', fill: '#adc6f0' },
  notificacao: { shape: 'circle', fill: '#f7ad90' },
};

const INK = '#1d1b18';

// Scalloped seal: 14 outward bumps on a 52px circle (viewBox 140).
const SEAL_D = (() => {
  const n = 14;
  const pt = (i: number) => {
    const a = (i / n) * Math.PI * 2 - Math.PI / 2;
    return `${(70 + Math.cos(a) * 52).toFixed(1)} ${(70 + Math.sin(a) * 52).toFixed(1)}`;
  };
  let d = `M${pt(0)}`;
  for (let i = 1; i <= n; i++) d += ` A12.5 12.5 0 0 1 ${pt(i)}`;
  return `${d} Z`;
})();

function Base({ shape, fill }: { shape: Shape; fill: string }) {
  if (shape === 'circle') {
    return (
      <>
        <circle cx="70" cy="70" r="57" fill="#fff" stroke="#fff" strokeWidth="16" />
        <circle cx="70" cy="70" r="57" fill={fill} stroke={INK} strokeWidth="5" />
      </>
    );
  }
  if (shape === 'seal') {
    return (
      <>
        <path d={SEAL_D} fill="#fff" stroke="#fff" strokeWidth="16" strokeLinejoin="round" />
        <path d={SEAL_D} fill={fill} stroke={INK} strokeWidth="5" strokeLinejoin="round" />
      </>
    );
  }
  return (
    <>
      <rect x="14" y="14" width="112" height="112" rx="34" fill="#fff" stroke="#fff" strokeWidth="16" />
      <rect x="14" y="14" width="112" height="112" rx="34" fill={fill} stroke={INK} strokeWidth="5" />
    </>
  );
}

function Icon({ kind }: { kind: StickerKind }) {
  switch (kind) {
    case 'conversa':
      return (
        <>
          <path
            d="M44 48 H96 A10 10 0 0 1 106 58 V82 A10 10 0 0 1 96 92 H66 L52 104 V92 H44 A10 10 0 0 1 34 82 V58 A10 10 0 0 1 44 48 Z"
            fill="#fff"
          />
          {[56, 70, 84].map((cx) => (
            <circle key={cx} className="sticker-dot" cx={cx} cy="70" r="4.5" fill={INK} stroke="none" />
          ))}
        </>
      );
    case 'enviado':
      return (
        <>
          <path className="sticker-draw" pathLength={100} d="M36 72 L50 86 L78 56" />
          <path className="sticker-draw" pathLength={100} d="M62 82 L66 86 L96 54" />
        </>
      );
    case 'agenda':
      return (
        <>
          <rect x="38" y="44" width="64" height="58" rx="12" fill="#fff" />
          <path d="M38 62 H102 M56 36 V50 M84 36 V50" />
          <path className="sticker-draw" pathLength={100} d="M58 82 L66 90 L82 74" />
        </>
      );
    case 'crescimento':
      return (
        <>
          <rect className="sticker-bar" x="40" y="74" width="14" height="22" rx="4" fill="#fff" />
          <rect className="sticker-bar" x="63" y="60" width="14" height="36" rx="4" fill="#fff" />
          <rect className="sticker-bar" x="86" y="44" width="14" height="52" rx="4" fill="#fff" />
        </>
      );
    case 'ia':
      return (
        <>
          <path
            d="M64 42 C66 62 70 66 90 70 C70 74 66 78 64 98 C62 78 58 74 38 70 C58 66 62 62 64 42 Z"
            fill="#fff"
          />
          <path
            d="M94 34 C95 42 97 44 105 45 C97 46 95 48 94 56 C93 48 91 46 83 45 C91 44 93 42 94 34 Z"
            fill={INK}
            strokeWidth="3"
          />
        </>
      );
    case 'ganho':
      return (
        <>
          <path d="M52 44 H88 V60 A18 18 0 0 1 52 60 Z" fill="#fff" />
          <path d="M52 50 H44 A9 9 0 0 0 53 66 M88 50 H96 A9 9 0 0 1 87 66 M70 78 V90 M58 96 H82" />
        </>
      );
    case 'contato':
      return (
        <>
          <circle cx="70" cy="58" r="13" fill="#fff" />
          <path d="M45 96 A25 22 0 0 1 95 96 Z" fill="#fff" />
        </>
      );
    case 'notificacao':
      return (
        <>
          <path d="M70 40 A18 18 0 0 1 88 58 V74 L95 84 H45 L52 74 V58 A18 18 0 0 1 70 40 Z" fill="#fff" />
          <path d="M63 92 A7 7 0 0 0 77 92" />
        </>
      );
  }
}

/**
 * Die-cut "sticker" illustration from the v7 design direction — pastel
 * shape, thin ink outline, white border, CRM icon. Decorative only:
 * always aria-hidden, so callers carry the meaning in text.
 */
export function Sticker({
  kind,
  className,
  style,
}: {
  kind: StickerKind;
  className?: string;
  style?: CSSProperties;
}) {
  const { shape, fill } = META[kind];
  return (
    <svg
      viewBox="0 0 140 140"
      aria-hidden="true"
      focusable="false"
      className={className}
      style={{ overflow: 'visible', filter: 'drop-shadow(0 6px 10px rgb(29 27 24 / 0.16))', ...style }}
    >
      <Base shape={shape} fill={fill} />
      <g fill="none" stroke={INK} strokeWidth="5.5" strokeLinecap="round" strokeLinejoin="round">
        <Icon kind={kind} />
      </g>
    </svg>
  );
}
