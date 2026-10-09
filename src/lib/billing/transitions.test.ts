import { describe, expect, it } from 'vitest';
import {
  addOneMonth,
  chargeOutcome,
  isFullyPaid,
  nextPeriodEnd,
  pixOrderStatus,
  subscriptionStatusFromPreapproval,
  toCents,
} from './transitions';

describe('toCents', () => {
  it('parses money strings and numbers', () => {
    expect(toCents('197.00')).toBe(19700);
    expect(toCents('164.17')).toBe(16417);
    expect(toCents(397)).toBe(39700);
    expect(toCents('0.1')).toBe(10);
  });
  it('rejects anything that is not plain money', () => {
    for (const v of ['', 'abc', '1e3', '-5', '12.345', null, undefined, NaN]) {
      expect(toCents(v)).toBeNull();
    }
  });
});

describe('status mapping', () => {
  it('treats only processed orders as paid; unknown stays pending', () => {
    expect(pixOrderStatus('processed')).toBe('paid');
    expect(pixOrderStatus('action_required')).toBe('pending');
    expect(pixOrderStatus('created')).toBe('pending');
    expect(pixOrderStatus('???')).toBe('pending');
    expect(pixOrderStatus('expired')).toBe('expired');
    expect(pixOrderStatus('canceled')).toBe('canceled');
    expect(pixOrderStatus('failed')).toBe('failed');
  });

  it('maps preapproval statuses', () => {
    expect(subscriptionStatusFromPreapproval('authorized')).toBe('active');
    expect(subscriptionStatusFromPreapproval('paused')).toBe('past_due');
    expect(subscriptionStatusFromPreapproval('cancelled')).toBe('canceled');
    expect(subscriptionStatusFromPreapproval('pending')).toBe('pending');
    // unknown statuses change nothing (they used to downgrade to pending)
    expect(subscriptionStatusFromPreapproval(undefined)).toBeNull();
    expect(subscriptionStatusFromPreapproval('finished')).toBeNull();
  });

  it('maps a monthly card charge', () => {
    expect(chargeOutcome('processed')).toBe('paid');
    expect(chargeOutcome('recycling')).toBe('retrying');
    expect(chargeOutcome('rejected')).toBe('failed');
    expect(chargeOutcome('scheduled')).toBe('pending');
  });
});

describe('addOneMonth', () => {
  it('adds a calendar month', () => {
    expect(addOneMonth(new Date('2026-10-06T12:00:00Z')).toISOString()).toBe(
      '2026-11-06T12:00:00.000Z'
    );
  });
  it('clamps to the end of a shorter month', () => {
    expect(addOneMonth(new Date('2026-01-31T00:00:00Z')).toISOString()).toBe(
      '2026-02-28T00:00:00.000Z'
    );
    expect(addOneMonth(new Date('2028-01-31T00:00:00Z')).toISOString()).toBe(
      '2028-02-29T00:00:00.000Z'
    );
  });
  it('rolls over the year', () => {
    expect(addOneMonth(new Date('2026-12-15T00:00:00Z')).toISOString()).toBe(
      '2027-01-15T00:00:00.000Z'
    );
  });
});

describe('nextPeriodEnd', () => {
  const paidAt = new Date('2026-10-06T00:00:00Z');
  it('extends a period that is still running', () => {
    expect(
      nextPeriodEnd(new Date('2026-10-20T00:00:00Z'), paidAt).toISOString()
    ).toBe('2026-11-20T00:00:00.000Z');
  });
  it('starts a fresh month when the last one already ended or is unset', () => {
    expect(
      nextPeriodEnd(new Date('2026-09-01T00:00:00Z'), paidAt).toISOString()
    ).toBe('2026-11-06T00:00:00.000Z');
    expect(nextPeriodEnd(null, paidAt).toISOString()).toBe(
      '2026-11-06T00:00:00.000Z'
    );
  });
});

describe('isFullyPaid', () => {
  it('stops an annual plan after its 12 charges', () => {
    expect(isFullyPaid(11, 12)).toBe(false);
    expect(isFullyPaid(12, 12)).toBe(true);
    expect(isFullyPaid(40, null)).toBe(false);
  });
});
