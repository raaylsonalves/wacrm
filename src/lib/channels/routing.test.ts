import { describe, it, expect } from 'vitest';
import {
  eligibleAssigneesFromMap,
  policiesToMap,
  CLOUD_API_POLICY_KEY,
  type ChannelPolicyEntry,
} from './routing';

describe('policiesToMap / eligibleAssigneesFromMap', () => {
  it('maps a WAHA channel policy by its id', () => {
    const entries: ChannelPolicyEntry[] = [
      { channelId: 'chan-1', responsibleUserIds: ['u1', 'u2'] },
    ];
    const map = policiesToMap(entries);
    expect(eligibleAssigneesFromMap(map, 'chan-1')).toEqual(['u1', 'u2']);
  });

  it('maps the Cloud API policy under the sentinel key, not null', () => {
    const entries: ChannelPolicyEntry[] = [
      { channelId: null, responsibleUserIds: ['u1'] },
    ];
    const map = policiesToMap(entries);
    expect(map.has(CLOUD_API_POLICY_KEY)).toBe(true);
    expect(eligibleAssigneesFromMap(map, null)).toEqual(['u1']);
  });

  it('returns null (unrestricted) for a channel with no policy row', () => {
    const map = policiesToMap([
      { channelId: 'chan-1', responsibleUserIds: [] },
    ]);
    expect(eligibleAssigneesFromMap(map, 'chan-2')).toBeNull();
    expect(eligibleAssigneesFromMap(map, null)).toBeNull();
  });

  it('returns an empty array (restricted_empty) for a policy with zero responsibles', () => {
    const map = policiesToMap([
      { channelId: 'chan-1', responsibleUserIds: [] },
    ]);
    expect(eligibleAssigneesFromMap(map, 'chan-1')).toEqual([]);
  });
});
