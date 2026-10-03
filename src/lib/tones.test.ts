import { describe, expect, it } from 'vitest';
import { TONES, toneFor } from './tones';

describe('toneFor', () => {
  it('is stable for the same seed', () => {
    expect(toneFor('Ana Lima')).toBe(toneFor('Ana Lima'));
  });

  it('always returns a known tone, even for empty input', () => {
    for (const seed of ['', null, undefined, 'x', 'João Pedro', '+55 11 90000-0000']) {
      expect(TONES).toContain(toneFor(seed));
    }
  });

  it('spreads different seeds across more than one tone', () => {
    const seen = new Set(['Ana', 'Bia', 'Caio', 'Duda', 'Edu', 'Fábio', 'Gabi', 'Hugo'].map(toneFor));
    expect(seen.size).toBeGreaterThan(1);
  });
});
