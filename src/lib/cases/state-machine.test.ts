import { describe, it, expect } from 'vitest'
import { canTransition, isOpen } from './state-machine'

describe('canTransition', () => {
  it.each([
    ['awaiting_human', 'done', 'resolved'],
    ['awaiting_human', 'need_info', 'awaiting_lead'],
    ['awaiting_lead', 'lead_provided', 'awaiting_human'],
    ['awaiting_human', 'escalate', 'escalated'],
    ['awaiting_lead', 'cancel', 'cancelled'],
    ['awaiting_lead', 'done', 'resolved'],
  ] as const)('%s --%s--> %s', (from, action, to) => {
    expect(canTransition(from, action)).toEqual({ ok: true, to })
  })

  it.each([
    ['resolved', 'need_info'],
    ['cancelled', 'done'],
    ['escalated', 'lead_provided'],
    ['resolved', 'lead_provided'],
    ['cancelled', 'escalate'],
  ] as const)('rejects %s --%s', (from, action) => {
    expect(canTransition(from, action)).toEqual({ ok: false, error: 'illegal_transition' })
  })

  it('a double click is a no-op, not an error', () => {
    expect(canTransition('resolved', 'done')).toEqual({ ok: true, to: 'resolved', noop: true })
    expect(canTransition('awaiting_lead', 'need_info')).toEqual({ ok: true, to: 'awaiting_lead', noop: true })
    expect(canTransition('awaiting_human', 'lead_provided')).toEqual({ ok: true, to: 'awaiting_human', noop: true })
  })

  it('open means someone still has to act', () => {
    expect(isOpen('awaiting_lead')).toBe(true)
    expect(isOpen('resolved')).toBe(false)
  })
})
