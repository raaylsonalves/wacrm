import { describe, it, expect } from 'vitest'
import { commandOf, formatSpan, initialsOf, windowState } from './signals'

describe('commandOf', () => {
  it('closed wins, then a person, then a stopped AI, then the AI', () => {
    expect(commandOf({ status: 'closed', assignedAgentId: 'u' })).toBe('closed')
    expect(commandOf({ status: 'open', assignedAgentId: 'u', aiOn: true })).toBe('human')
    expect(commandOf({ status: 'open', aiAutoreplyDisabled: true, aiOn: true })).toBe('waiting')
    expect(commandOf({ status: 'open', aiOn: true })).toBe('ai')
  })
  it('does not claim the AI answers when that is unknown', () => {
    expect(commandOf({ status: 'open' })).toBe('nobody')
  })
})

describe('windowState', () => {
  const now = new Date('2026-09-29T12:00:00Z')
  it('only the official API has a window', () => {
    expect(windowState({ isOfficialApi: false, lastCustomerMessageAt: null, now })).toEqual({ kind: 'none' })
  })
  it('open, urgent under 2h, closed after 24h, closed when the customer never wrote', () => {
    expect(windowState({ isOfficialApi: true, lastCustomerMessageAt: '2026-09-29T02:00:00Z', now })).toMatchObject({
      kind: 'open',
      urgent: false,
    })
    expect(windowState({ isOfficialApi: true, lastCustomerMessageAt: '2026-09-28T13:00:00Z', now })).toMatchObject({
      kind: 'open',
      urgent: true,
    })
    expect(windowState({ isOfficialApi: true, lastCustomerMessageAt: '2026-09-26T12:00:00Z', now })).toEqual({
      kind: 'closed',
      closedForMs: 2 * 86_400_000,
    })
    expect(windowState({ isOfficialApi: true, lastCustomerMessageAt: null, now })).toEqual({
      kind: 'closed',
      closedForMs: null,
    })
  })
})

describe('formatting', () => {
  it('compact spans', () => {
    expect(formatSpan(35 * 60_000)).toBe('35min')
    expect(formatSpan(5 * 3600_000)).toBe('5h')
    expect(formatSpan(3 * 86_400_000)).toBe('3d')
  })
  it('initials', () => {
    expect(initialsOf('Ana Souza Lima')).toBe('AL')
    expect(initialsOf('Raylson')).toBe('RA')
    expect(initialsOf('5511987654321')).toBe('55')
  })
})
