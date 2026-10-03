/**
 * The v2 pastel tones (globals.css `--tone-*`) as ready-made class
 * strings. Static literals so Tailwind can see them.
 */
export const TONES = ['lilac', 'mint', 'salmon', 'blue'] as const;

export type Tone = (typeof TONES)[number];

/** Solid swatch with ink text — avatars, KPI cards. */
export const TONE_SOLID: Record<Tone, string> = {
  lilac: 'bg-tone-lilac text-tone-on',
  mint: 'bg-tone-mint text-tone-on',
  salmon: 'bg-tone-salmon text-tone-on',
  blue: 'bg-tone-blue text-tone-on',
};

/** Tinted background with readable ink — tags, status chips. */
export const TONE_SOFT: Record<Tone, string> = {
  lilac: 'bg-tone-lilac-soft text-tone-lilac-ink',
  mint: 'bg-tone-mint-soft text-tone-mint-ink',
  salmon: 'bg-tone-salmon-soft text-tone-salmon-ink',
  blue: 'bg-tone-blue-soft text-tone-blue-ink',
};

/**
 * A stable tone for a person or thing, so the same contact keeps the
 * same avatar colour in every list. Not cryptographic — just a spread.
 */
export function toneFor(seed: string | null | undefined): Tone {
  const s = seed ?? '';
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return TONES[Math.abs(h) % TONES.length];
}
