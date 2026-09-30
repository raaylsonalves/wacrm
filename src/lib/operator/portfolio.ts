/** One row of operator_portfolio() (migration 090). */
export interface PortfolioRow {
  account_id: string;
  name: string;
  is_home: boolean;
  is_active: boolean;
  owner_is_operator: boolean;
  meta_status: string | null;
  waha_total: number;
  waha_down: number;
  ai_on: boolean;
  awaiting_reply: number;
  handoff_waiting: number;
  open_cases: number;
  appointments_today: number;
  tokens_7d: number;
  last_inbound_at: string | null;
}

/**
 * How urgently a client needs the operator — the portfolio sorts by it.
 * A number that dropped outranks everything: the client is losing
 * messages and usually doesn't know yet.
 */
export function attentionScore(r: PortfolioRow): number {
  let s = 0;
  if (r.waha_down > 0) s += 100 * r.waha_down;
  if (r.meta_status && r.meta_status !== 'connected') s += 100;
  if (!r.meta_status && r.waha_total === 0) s += 50;
  s += 10 * r.handoff_waiting;
  s += 5 * r.open_cases;
  s += r.awaiting_reply;
  if (!r.ai_on) s += 3;
  return s;
}
