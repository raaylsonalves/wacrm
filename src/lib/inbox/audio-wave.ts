/**
 * Waveform bars for the inbox voice-note player. Real peaks when the audio
 * can be decoded in the browser; otherwise a stable pseudo-waveform seeded
 * by the message id, so a bubble never changes shape between renders.
 */
export const WAVE_BARS = 40;

/** Peak per bucket of a decoded channel, scaled to 0.15–1. */
export function peaksFromChannel(
  data: ArrayLike<number>,
  bars: number = WAVE_BARS
): number[] {
  if (data.length === 0 || bars <= 0) return fallbackPeaks('empty', bars);
  const size = Math.max(1, Math.floor(data.length / bars));
  const raw: number[] = [];
  for (let b = 0; b < bars; b++) {
    let peak = 0;
    const from = b * size;
    const to = Math.min(data.length, from + size);
    for (let i = from; i < to; i++) {
      const v = Math.abs(data[i]);
      if (v > peak) peak = v;
    }
    raw.push(peak);
  }
  const max = Math.max(...raw);
  if (max === 0) return raw.map(() => 0.15);
  return raw.map((v) => 0.15 + 0.85 * (v / max));
}

/** Deterministic bars from a string seed (mulberry32 over a string hash). */
export function fallbackPeaks(
  seed: string,
  bars: number = WAVE_BARS
): number[] {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  const out: number[] = [];
  for (let i = 0; i < bars; i++) {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    const r = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    out.push(0.2 + 0.8 * r);
  }
  return out;
}

/** 75 → "1:15"; unknown/invalid → "0:00". */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const s = Math.floor(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
