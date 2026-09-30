import { describe, it, expect } from 'vitest';
import { attentionScore, type PortfolioRow } from './portfolio';

const base: PortfolioRow = {
  account_id: 'a',
  name: 'A',
  is_home: false,
  is_active: false,
  owner_is_operator: false,
  meta_status: 'connected',
  waha_total: 0,
  waha_down: 0,
  ai_on: true,
  awaiting_reply: 0,
  handoff_waiting: 0,
  open_cases: 0,
  appointments_today: 0,
  tokens_7d: 0,
  last_inbound_at: null,
};

describe('attentionScore', () => {
  it('a healthy account scores zero', () => {
    expect(attentionScore(base)).toBe(0);
  });

  it('a dropped number outranks a busy inbox', () => {
    const dropped = { ...base, waha_total: 1, waha_down: 1 };
    const busy = {
      ...base,
      awaiting_reply: 30,
      handoff_waiting: 2,
      open_cases: 3,
    };
    expect(attentionScore(dropped)).toBeGreaterThan(attentionScore(busy));
  });

  it('no number at all is flagged', () => {
    expect(attentionScore({ ...base, meta_status: null })).toBeGreaterThan(0);
  });
});
