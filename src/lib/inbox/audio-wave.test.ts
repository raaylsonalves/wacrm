import { describe, it, expect } from 'vitest';
import {
  WAVE_BARS,
  fallbackPeaks,
  formatDuration,
  peaksFromChannel,
} from './audio-wave';

describe('peaksFromChannel', () => {
  it('returns one peak per bar, loudest bucket at 1', () => {
    const data = new Float32Array(400);
    data[250] = -0.8; // loud spike in the 26th bucket of 40
    data[10] = 0.2;
    const p = peaksFromChannel(data, 40);
    expect(p).toHaveLength(40);
    expect(Math.max(...p)).toBeCloseTo(1);
    expect(p[25]).toBeCloseTo(1);
    expect(p[1]).toBeCloseTo(0.15 + 0.85 * 0.25);
  });

  it('silence stays a flat floor', () => {
    expect(peaksFromChannel(new Float32Array(100), 10)).toEqual(
      Array(10).fill(0.15)
    );
  });
});

describe('fallbackPeaks', () => {
  it('is stable for a seed and differs between seeds', () => {
    expect(fallbackPeaks('abc')).toEqual(fallbackPeaks('abc'));
    expect(fallbackPeaks('abc')).not.toEqual(fallbackPeaks('abd'));
    expect(fallbackPeaks('abc')).toHaveLength(WAVE_BARS);
  });

  it('stays inside 0.2–1', () => {
    for (const v of fallbackPeaks('x', 200)) {
      expect(v).toBeGreaterThanOrEqual(0.2);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

describe('formatDuration', () => {
  it('formats m:ss and guards bad input', () => {
    expect(formatDuration(75)).toBe('1:15');
    expect(formatDuration(5.9)).toBe('0:05');
    expect(formatDuration(NaN)).toBe('0:00');
    expect(formatDuration(Infinity)).toBe('0:00');
  });
});
