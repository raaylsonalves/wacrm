import { describe, it, expect } from 'vitest';
import { shouldNudgePush } from './use-push-control';

describe('shouldNudgePush', () => {
  const base = {
    support: 'supported',
    configured: true,
    subscribed: false,
  } as const;

  it('nudges a supported device that has push off', () => {
    expect(shouldNudgePush(base)).toBe(true);
  });

  it('nudges an iPhone in Safari too (to install first)', () => {
    expect(shouldNudgePush({ ...base, support: 'ios-needs-install' })).toBe(
      true
    );
  });

  it('never nudges when already on', () => {
    expect(shouldNudgePush({ ...base, subscribed: true })).toBe(false);
  });

  it('never nags about something unfixable', () => {
    expect(shouldNudgePush({ ...base, configured: false })).toBe(false);
    expect(shouldNudgePush({ ...base, configured: null })).toBe(false);
    expect(shouldNudgePush({ ...base, support: 'unsupported' })).toBe(false);
    expect(shouldNudgePush({ ...base, support: null })).toBe(false);
  });
});
