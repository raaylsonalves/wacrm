import { describe, expect, it } from 'vitest';
import { idleHours } from './arrival';
import { triggerMatches } from './engine';
import type { Automation } from '@/types';

describe('customer_arrived', () => {
  it('measures the quiet time before the newest message', () => {
    expect(idleHours(['2026-10-20T15:00:00Z'])).toBeNull();
    expect(idleHours(['2026-10-20T15:00:00Z', '2026-10-20T01:00:00Z'])).toBe(
      14
    );
  });

  const auto = (cfg: Record<string, unknown>) =>
    ({
      trigger_type: 'customer_arrived',
      trigger_config: cfg,
    }) as unknown as Automation;

  it('fires on a first message and after the idle window (default 12 h)', () => {
    expect(triggerMatches(auto({}), { idle_hours: null })).toBe(true);
    expect(triggerMatches(auto({}), { idle_hours: 13 })).toBe(true);
    expect(triggerMatches(auto({}), { idle_hours: 2 })).toBe(false);
    expect(triggerMatches(auto({ idle_hours: 1 }), { idle_hours: 2 })).toBe(
      true
    );
    expect(triggerMatches(auto({}), {})).toBe(false);
  });
});
