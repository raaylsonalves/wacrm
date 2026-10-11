'use client';

import { useMemo } from 'react';
import { useAuth } from '@/hooks/use-auth';
import {
  canUse,
  entitlementsFor,
  FEATURE_MIN_PLAN,
  hasRoomFor,
  type PlanCount,
  type PlanFeature,
} from '@/lib/billing/entitlements';
import type { PlanId } from '@/lib/billing/plans';

/**
 * What the current account's plan includes — the UI side of migration 129.
 * The database still refuses whatever this lets through by mistake; this
 * only lets the screen explain before the click.
 */
export function useEntitlements(): {
  can: (feature: PlanFeature) => boolean;
  roomFor: (what: PlanCount, used: number) => boolean;
  limit: (what: PlanCount) => number | null;
  minPlanFor: (feature: PlanFeature) => PlanId;
} {
  const { account } = useAuth();
  const plan = account?.plan ?? null;
  const status = account?.subscription_status ?? null;
  return useMemo(() => {
    const e = entitlementsFor({ plan, subscription_status: status });
    return {
      can: (feature) => canUse(e, feature),
      roomFor: (what, used) => hasRoomFor(e, what, used),
      limit: (what) => e.limits[what],
      minPlanFor: (feature) => FEATURE_MIN_PLAN[feature],
    };
  }, [plan, status]);
}
