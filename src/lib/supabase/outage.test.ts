import { describe, expect, it } from 'vitest';
import { initialOutage, nextOutage, OUTAGE_THRESHOLD } from './outage';

const fold = (statuses: (number | null)[]) =>
  statuses.reduce(nextOutage, initialOutage);

describe('nextOutage', () => {
  it('goes down after consecutive gateway failures', () => {
    expect(fold(Array(OUTAGE_THRESHOLD - 1).fill(504)).down).toBe(false);
    expect(fold(Array(OUTAGE_THRESHOLD).fill(504)).down).toBe(true);
    expect(fold([503, null, 502]).down).toBe(true);
  });

  it('ignores app errors (4xx, 500) and recovers on any real answer', () => {
    expect(fold([401, 404, 500, 409]).failures).toBe(0);
    expect(fold([504, 504, 200, 504]).down).toBe(false);
    expect(fold([504, 504, 504, 200])).toEqual(initialOutage);
  });

  it('keeps the same object when nothing changes', () => {
    expect(nextOutage(initialOutage, 200)).toBe(initialOutage);
  });
});
