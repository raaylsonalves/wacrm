import { describe, expect, it } from 'vitest';
import {
  canUse,
  entitlementsFor,
  hasRoomFor,
  planGateFromError,
  planGateResponse,
} from './entitlements';

describe('entitlementsFor', () => {
  it('matches what the landing advertises', () => {
    const e = entitlementsFor({
      plan: 'essencial',
      subscription_status: 'active',
    });
    expect(e.limits).toEqual({ agents: 1, users: 3 });
    expect(canUse(e, 'broadcasts')).toBe(false);

    const p = entitlementsFor({
      plan: 'profissional',
      subscription_status: 'active',
    });
    expect(p.limits).toEqual({ agents: 5, users: 8 });
    expect(canUse(p, 'router')).toBe(true);
    expect(canUse(p, 'api')).toBe(false);

    const s = entitlementsFor({
      plan: 'escala',
      subscription_status: 'past_due',
    });
    expect(s.limits).toEqual({ agents: null, users: 20 });
    expect(canUse(s, 'api')).toBe(true);
  });

  it('gives everything to exempt accounts and accounts without a plan', () => {
    for (const a of [
      { plan: 'essencial', subscription_status: 'exempt' },
      { plan: null, subscription_status: 'active' },
      { plan: 'unknown', subscription_status: 'active' },
    ]) {
      const e = entitlementsFor(a);
      expect(e.limits.agents).toBeNull();
      expect(canUse(e, 'api')).toBe(true);
    }
  });

  it('hasRoomFor counts against the limit', () => {
    const e = entitlementsFor({
      plan: 'essencial',
      subscription_status: 'active',
    });
    expect(hasRoomFor(e, 'agents', 0)).toBe(true);
    expect(hasRoomFor(e, 'agents', 1)).toBe(false);
  });
});

describe('planGateFromError', () => {
  it('reads the trigger errors', () => {
    expect(planGateFromError({ message: 'plan_limit_reached:agents' })).toEqual(
      {
        kind: 'limit',
        key: 'agents',
      }
    );
    expect(
      planGateFromError({ message: 'plan_feature_unavailable:broadcasts' })
    ).toEqual({ kind: 'feature', key: 'broadcasts' });
    expect(planGateFromError({ message: 'duplicate key' })).toBeNull();
    expect(planGateFromError(null)).toBeNull();
  });

  it('turns them into a 403', async () => {
    const res = planGateResponse({ message: 'plan_feature_unavailable:api' });
    expect(res?.status).toBe(403);
    expect(await res?.json()).toMatchObject({
      code: 'plan_upgrade_required',
      feature: 'api',
    });
    expect(planGateResponse({ message: 'other' })).toBeNull();
  });
});
