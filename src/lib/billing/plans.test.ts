import { describe, expect, it } from 'vitest';
import {
  annualMonthlyBrl,
  isBillingCycle,
  isPlanId,
  quoteSubscription,
} from './plans';

describe('quoteSubscription', () => {
  it('prices monthly at the table price, open-ended', () => {
    expect(quoteSubscription('profissional', 'monthly')).toEqual({
      amountCents: 39700,
      chargesTotal: null,
    });
  });

  it('prices annual as 10 months over 12 charges, capped at 12', () => {
    expect(quoteSubscription('essencial', 'annual')).toEqual({
      amountCents: 16417,
      chargesTotal: 12,
    });
    expect(annualMonthlyBrl('escala')).toBe(664.17);
  });
});

describe('guards', () => {
  it('only accepts known plans and cycles', () => {
    expect(isPlanId('escala')).toBe(true);
    expect(isPlanId('gratis')).toBe(false);
    expect(isPlanId(undefined)).toBe(false);
    expect(isBillingCycle('annual')).toBe(true);
    expect(isBillingCycle('weekly')).toBe(false);
  });
});
