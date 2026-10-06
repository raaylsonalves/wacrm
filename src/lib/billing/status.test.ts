import { describe, expect, it } from 'vitest';
import { canInviteMembers, isAccountUsable } from './status';

describe('isAccountUsable', () => {
  it('blocks only unpaid accounts; unknown values fail closed', () => {
    expect(isAccountUsable('pending')).toBe(false);
    expect(isAccountUsable('')).toBe(false);
    expect(isAccountUsable('hacked')).toBe(false);
    expect(isAccountUsable('canceled')).toBe(false);
    for (const s of ['active', 'exempt', 'past_due']) {
      expect(isAccountUsable(s)).toBe(true);
    }
  });
});

describe('canInviteMembers', () => {
  it('needs an active or exempt account', () => {
    expect(canInviteMembers('active')).toBe(true);
    expect(canInviteMembers('exempt')).toBe(true);
    expect(canInviteMembers('pending')).toBe(false);
    expect(canInviteMembers('past_due')).toBe(false);
    expect(canInviteMembers(null)).toBe(false);
  });
});
