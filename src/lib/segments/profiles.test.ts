import { describe, expect, it } from 'vitest';
import { LOSS_REASONS } from '@/lib/leads/origin';
import { SEGMENT_PROFILES, profileFor, stageRows } from './profiles';

describe('segment profiles', () => {
  it('every profile orders all loss reasons exactly once', () => {
    for (const p of Object.values(SEGMENT_PROFILES)) {
      expect([...p.lossOrder].sort()).toEqual([...LOSS_REASONS].sort());
    }
  });
  it('unknown segment falls back to the generic profile', () => {
    expect(profileFor(null)).toBe(SEGMENT_PROFILES.other);
    expect(profileFor('finance').term).toBe('proposal');
  });
  it('stageRows ends green', () => {
    const rows = stageRows(['a', 'b', 'c']);
    expect(rows.map((r) => r.position)).toEqual([0, 1, 2]);
    expect(rows[2].color).toBe('#22c55e');
  });
});
