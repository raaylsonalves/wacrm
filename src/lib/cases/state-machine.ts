/**
 * The case state machine (specs/human-cases.md §3) — the single authority
 * on which transitions are allowed. The DB CHECK guards the vocabulary;
 * this table guards the order. Every route asks `canTransition` before
 * writing. Pure.
 *
 *   awaiting_human ──human: done──────────► resolved      (AI relays outcome)
 *   awaiting_human ──human: need info─────► awaiting_lead (AI asks customer)
 *   awaiting_lead  ──AI: provide update───► awaiting_human
 *   awaiting_human ──human: take over─────► escalated     (handoff)
 *   any open       ──human/system: cancel─► cancelled
 */

export const CASE_STATUSES = [
  'awaiting_human',
  'awaiting_lead',
  'resolved',
  'escalated',
  'cancelled',
] as const
export type CaseStatus = (typeof CASE_STATUSES)[number]

export type CaseAction = 'done' | 'need_info' | 'escalate' | 'cancel' | 'lead_provided'

const ALLOWED: Record<CaseAction, { from: CaseStatus[]; to: CaseStatus }> = {
  done: { from: ['awaiting_human', 'awaiting_lead'], to: 'resolved' },
  need_info: { from: ['awaiting_human'], to: 'awaiting_lead' },
  escalate: { from: ['awaiting_human', 'awaiting_lead'], to: 'escalated' },
  cancel: { from: ['awaiting_human', 'awaiting_lead'], to: 'cancelled' },
  lead_provided: { from: ['awaiting_lead'], to: 'awaiting_human' },
}

export type TransitionResult =
  | { ok: true; to: CaseStatus }
  /** Already in the target state — a double click is a no-op, not an error. */
  | { ok: true; to: CaseStatus; noop: true }
  | { ok: false; error: 'illegal_transition' }

export function canTransition(from: CaseStatus, action: CaseAction): TransitionResult {
  const rule = ALLOWED[action]
  if (from === rule.to) return { ok: true, to: rule.to, noop: true }
  if (rule.from.includes(from)) return { ok: true, to: rule.to }
  return { ok: false, error: 'illegal_transition' }
}

export function isOpen(status: CaseStatus): boolean {
  return status === 'awaiting_human' || status === 'awaiting_lead'
}

/** Most open cases one conversation may hold — a looping model can't flood the queue. */
export const MAX_OPEN_PER_CONVERSATION = 3
/** Most cases the AI may open per account per hour. */
export const MAX_OPENED_PER_HOUR = 30
