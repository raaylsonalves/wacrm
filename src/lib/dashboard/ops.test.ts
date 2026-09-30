import { describe, it, expect } from 'vitest';
import { aiShare, heatLevel, heatmapMatrix, HEAT_ROWS } from './ops';

describe('heatmapMatrix', () => {
  it('places cells Monday-first and finds the peak', () => {
    const { grid, max, peak } = heatmapMatrix([
      { dow: 1, hour: 9, n: 4 },
      { dow: 0, hour: 20, n: 7 },
      { dow: 3, hour: 14, n: 2 },
    ]);
    expect(grid).toHaveLength(7);
    expect(grid[0][9]).toBe(4); // Monday row
    expect(grid[HEAT_ROWS.indexOf(0)][20]).toBe(7); // Sunday is last
    expect(max).toBe(7);
    expect(peak).toEqual({ dow: 0, hour: 20, n: 7 });
  });

  it('empty data has no peak', () => {
    expect(heatmapMatrix([]).peak).toBeNull();
  });
});

describe('heatLevel', () => {
  it('buckets 0–4 relative to the max', () => {
    expect(heatLevel(0, 10)).toBe(0);
    expect(heatLevel(1, 10)).toBe(1);
    expect(heatLevel(5, 10)).toBe(2);
    expect(heatLevel(10, 10)).toBe(4);
  });
});

describe('aiShare', () => {
  it('rounds the AI share; null with no replies', () => {
    expect(aiShare(3, 1)).toBe(75);
    expect(aiShare(0, 5)).toBe(0);
    expect(aiShare(0, 0)).toBeNull();
  });
});
