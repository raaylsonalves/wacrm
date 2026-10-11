// What each plan may use (specs/pricing-costs.md, section 10).
//
// The database is the real gate: migration 129's triggers refuse a new
// agent, router, broadcast, prospecting campaign, API key, webhook or
// invitation beyond the plan. This file mirrors those rules so the UI can
// explain instead of failing after the click, and turns the trigger's
// error into a clear 403. Keep it in step with plan_allows / plan_limit
// in 129_plan_entitlements.sql — the same two-sided pattern as roles.ts.

import { NextResponse } from 'next/server';
import type { PlanId } from './plans';

export type PlanFeature =
  'router' | 'broadcasts' | 'prospecting' | 'followups' | 'api';
export type PlanCount = 'agents' | 'users';

export interface Entitlements {
  features: Record<PlanFeature, boolean>;
  /** null = unlimited. */
  limits: Record<PlanCount, number | null>;
}

const ALL: Entitlements = {
  features: {
    router: true,
    broadcasts: true,
    prospecting: true,
    followups: true,
    api: true,
  },
  limits: { agents: null, users: null },
};

const BY_PLAN: Record<PlanId, Entitlements> = {
  essencial: {
    features: {
      router: false,
      broadcasts: false,
      prospecting: false,
      followups: false,
      api: false,
    },
    limits: { agents: 1, users: 3 },
  },
  profissional: {
    features: {
      router: true,
      broadcasts: true,
      prospecting: true,
      followups: true,
      api: false,
    },
    limits: { agents: 5, users: 8 },
  },
  escala: { features: ALL.features, limits: { agents: null, users: 20 } },
};

/** Cheapest plan that unlocks a feature — for the "available on" badge. */
export const FEATURE_MIN_PLAN: Record<PlanFeature, PlanId> = {
  router: 'profissional',
  broadcasts: 'profissional',
  prospecting: 'profissional',
  followups: 'profissional',
  api: 'escala',
};

/**
 * No plan (legacy, the platform) or an exempt account = everything,
 * exactly like plan_allows / plan_limit in SQL.
 */
export function entitlementsFor(account: {
  plan: string | null | undefined;
  subscription_status: string | null | undefined;
}): Entitlements {
  if (account.subscription_status === 'exempt') return ALL;
  const plan = account.plan as PlanId | null | undefined;
  return (plan && BY_PLAN[plan]) || ALL;
}

export function canUse(e: Entitlements, feature: PlanFeature): boolean {
  return e.features[feature];
}

/** Whether one more of `what` fits, given how many exist now. */
export function hasRoomFor(
  e: Entitlements,
  what: PlanCount,
  used: number
): boolean {
  const limit = e.limits[what];
  return limit === null || used < limit;
}

export interface PlanGate {
  kind: 'feature' | 'limit';
  /** The feature or the counted thing that was refused. */
  key: string;
}

/** Recognise migration 129's trigger errors. */
export function planGateFromError(
  err: { message?: string | null } | null | undefined
): PlanGate | null {
  const m = err?.message?.match(
    /plan_(feature_unavailable|limit_reached):(\w+)/
  );
  if (!m) return null;
  return { kind: m[1] === 'limit_reached' ? 'limit' : 'feature', key: m[2] };
}

/** A 403 the UI can turn into "available on the X plan", or null. */
export function planGateResponse(
  err: { message?: string | null } | null | undefined
): NextResponse | null {
  const gate = planGateFromError(err);
  if (!gate) return null;
  return NextResponse.json(
    {
      error:
        gate.kind === 'limit' ? 'plan_limit_reached' : 'plan_upgrade_required',
      code:
        gate.kind === 'limit' ? 'plan_limit_reached' : 'plan_upgrade_required',
      feature: gate.key,
    },
    { status: 403 }
  );
}
