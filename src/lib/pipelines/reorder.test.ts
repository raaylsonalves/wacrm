import { describe, it, expect } from 'vitest';
import { midpoint, computeDropPosition, type PositionedItem } from './reorder';

describe('midpoint', () => {
  it('starts at the default gap for an empty column', () => {
    expect(midpoint(null, null)).toBe(1024);
  });

  it('appends after prev when dropped at the end', () => {
    expect(midpoint(1024, null)).toBe(2048);
  });

  it('goes before next when dropped at the start', () => {
    expect(midpoint(null, 1024)).toBe(0);
  });

  it('splits the gap between two neighbors', () => {
    expect(midpoint(1024, 2048)).toBe(1536);
  });

  it('keeps splitting a shrinking gap without hitting zero', () => {
    const a = 0;
    let b = 1;
    for (let i = 0; i < 20; i++) {
      const m = midpoint(a, b);
      expect(m).toBeGreaterThan(a);
      expect(m).toBeLessThan(b);
      b = m;
    }
  });
});

describe('computeDropPosition', () => {
  const siblings: PositionedItem[] = [
    { id: 'a', position_in_stage: 1024 },
    { id: 'b', position_in_stage: 2048 },
    { id: 'c', position_in_stage: 3072 },
  ];

  it('drops at the start', () => {
    expect(computeDropPosition(siblings, 0)).toBe(0);
  });

  it('drops in the middle', () => {
    expect(computeDropPosition(siblings, 1)).toBe(1536);
  });

  it('drops at the end', () => {
    expect(computeDropPosition(siblings, 3)).toBe(4096);
  });

  it('drops into an empty column', () => {
    expect(computeDropPosition([], 0)).toBe(1024);
  });

  it('clamps an out-of-range index', () => {
    expect(computeDropPosition(siblings, 99)).toBe(4096);
    expect(computeDropPosition(siblings, -5)).toBe(0);
  });
});
