import { describe, expect, it } from 'vitest';
import {
  GRACE_MS,
  RENEW_BEFORE_MS,
  STALE_PENDING_MS,
  CARD_FIRST_CHARGE_MS,
  classifySubscription,
  monthStartOf,
  type SweepSubscription,
} from './sweep';

const NOW = new Date('2026-10-20T12:00:00Z');
const iso = (ms: number) => new Date(NOW.getTime() + ms).toISOString();

function sub(over: Partial<SweepSubscription> = {}): SweepSubscription {
  return {
    id: 's1',
    account_id: 'a1',
    method: 'pix',
    status: 'active',
    amount_cents: 39700,
    charges_paid: 1,
    charges_total: null,
    current_period_end: iso(20 * 86_400_000),
    grace_until: null,
    ...over,
  };
}

describe('classifySubscription', () => {
  it('never touches exempt accounts', () => {
    expect(
      classifySubscription(
        sub({ current_period_end: iso(-86_400_000) }),
        'exempt',
        NOW
      )
    ).toBeNull();
  });

  it('does nothing while a Pix period has plenty of time left', () => {
    expect(classifySubscription(sub(), 'active', NOW)).toBeNull();
  });

  it('creates the renewal charge 3 days before the period ends', () => {
    expect(
      classifySubscription(
        sub({ current_period_end: iso(RENEW_BEFORE_MS - 1000) }),
        'active',
        NOW
      )
    ).toBe('renew_pix');
  });

  it('does not renew a finished annual plan', () => {
    expect(
      classifySubscription(
        sub({
          current_period_end: iso(RENEW_BEFORE_MS - 1000),
          charges_paid: 12,
          charges_total: 12,
        }),
        'active',
        NOW
      )
    ).toBeNull();
  });

  it('moves an unpaid Pix period to past_due', () => {
    expect(
      classifySubscription(
        sub({ current_period_end: iso(-1000) }),
        'active',
        NOW
      )
    ).toBe('to_past_due');
  });

  it('never renews or expires a card subscription (Mercado Pago charges it)', () => {
    expect(
      classifySubscription(
        sub({ method: 'card', current_period_end: iso(-1000) }),
        'active',
        NOW
      )
    ).toBeNull();
  });

  it('lets a past_due account keep its grace, then lapses it', () => {
    const base = sub({
      status: 'past_due',
      current_period_end: iso(-GRACE_MS),
    });
    expect(
      classifySubscription({ ...base, grace_until: iso(1000) }, 'past_due', NOW)
    ).toBeNull();
    expect(
      classifySubscription(
        { ...base, grace_until: iso(-1000) },
        'past_due',
        NOW
      )
    ).toBe('lapse');
  });

  it('keeps a cancelled subscription usable until its paid period ends', () => {
    expect(
      classifySubscription(
        sub({ status: 'canceled', current_period_end: iso(5 * 86_400_000) }),
        'active',
        NOW
      )
    ).toBeNull();
    expect(
      classifySubscription(
        sub({ status: 'canceled', current_period_end: iso(-1000) }),
        'active',
        NOW
      )
    ).toBe('close_canceled');
  });

  it('does not close an account that is already canceled', () => {
    expect(
      classifySubscription(
        sub({ status: 'canceled', current_period_end: iso(-1000) }),
        'canceled',
        NOW
      )
    ).toBeNull();
  });
});

describe('monthStartOf', () => {
  it('returns the first day of the UTC month', () => {
    expect(monthStartOf(new Date('2026-11-20T23:59:00Z'))).toBe('2026-11-01');
    expect(monthStartOf(new Date('2026-12-01T00:00:00Z'))).toBe('2026-12-01');
  });
});

describe('classifySubscription — review 2026-10 hardening', () => {
  it('lapses a past_due row that has no grace date', () => {
    expect(
      classifySubscription(sub({ status: 'past_due', grace_until: null }), 'active', NOW)
    ).toBe('lapse');
  });

  it('closes a stale pending row that left the account usable', () => {
    const stale = sub({
      status: 'pending',
      method: 'card',
      mp_preapproval_id: null,
      current_period_end: null,
      updated_at: iso(-2 * STALE_PENDING_MS),
    });
    expect(classifySubscription(stale, 'active', NOW)).toBe('lapse');
    expect(classifySubscription(stale, 'past_due', NOW)).toBe('lapse');
  });

  it('leaves a pending row alone while it may still be a checkout', () => {
    expect(
      classifySubscription(
        sub({ status: 'pending', current_period_end: null, updated_at: iso(-60_000) }),
        'active',
        NOW
      )
    ).toBeNull();
  });

  it('leaves a pending row alone when a card subscription exists or the period runs', () => {
    const base = { status: 'pending' as const, updated_at: iso(-2 * STALE_PENDING_MS) };
    expect(
      classifySubscription(sub({ ...base, mp_preapproval_id: 'pre-1' }), 'active', NOW)
    ).toBeNull();
    expect(
      classifySubscription(sub({ ...base, current_period_end: iso(86_400_000) }), 'active', NOW)
    ).toBeNull();
  });

  it('does not touch a pending row on a locked account (normal new sign-up)', () => {
    expect(
      classifySubscription(
        sub({ status: 'pending', current_period_end: null, updated_at: iso(-2 * STALE_PENDING_MS) }),
        'pending',
        NOW
      )
    ).toBeNull();
  });

  it('closes a resumed card plan whose first charge never landed (QA)', () => {
    const base = {
      status: 'pending' as const,
      method: 'card' as const,
      mp_preapproval_id: 'pre-1',
      updated_at: iso(-30 * 86_400_000),
    };
    expect(
      classifySubscription(sub({ ...base, current_period_end: iso(-CARD_FIRST_CHARGE_MS - 1000) }), 'active', NOW)
    ).toBe('lapse');
    expect(
      classifySubscription(sub({ ...base, current_period_end: iso(-2 * 86_400_000) }), 'active', NOW)
    ).toBeNull();
  });
});
