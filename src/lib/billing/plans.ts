// Plan catalogue shared by the landing page, the onboarding suggestion and
// (later) the checkout. Prices here are the single source: the checkout
// must compute the charge from this table, never from a client value
// (specs/mercadopago-checkout.md).

export const PLAN_IDS = ['essencial', 'profissional', 'escala'] as const;
export type PlanId = (typeof PLAN_IDS)[number];

export const PLAN_MONTHLY_BRL: Record<PlanId, number> = {
  essencial: 197,
  profissional: 397,
  escala: 797,
};

/** Seats each plan includes — the same numbers the landing advertises. */
export const PLAN_USERS: Record<PlanId, number> = {
  essencial: 3,
  profissional: 8,
  escala: 20,
};

export function isPlanId(v: unknown): v is PlanId {
  return PLAN_IDS.includes(v as PlanId);
}

/** Annual = 10 months of price spread over 12 monthly charges. */
export function annualMonthlyBrl(plan: PlanId): number {
  return Math.round(((PLAN_MONTHLY_BRL[plan] * 10) / 12) * 100) / 100;
}
