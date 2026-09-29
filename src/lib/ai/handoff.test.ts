import { describe, it, expect } from 'vitest'
import { buildHandoffMeta, lastCustomerMessage } from './handoff'

describe('lastCustomerMessage', () => {
  it('returns the most recent customer message, whitespace collapsed', () => {
    expect(
      lastCustomerMessage([
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello! How can I help?' },
        { role: 'user', content: 'I want\n a   refund' },
      ]),
    ).toBe('I want a refund')
  })

  it('is null when there is no customer text', () => {
    expect(lastCustomerMessage([{ role: 'assistant', content: 'Hello' }])).toBeNull()
    expect(lastCustomerMessage([{ role: 'user', content: '   ' }])).toBeNull()
  })

  it('bounds a very long message and ellipsizes it', () => {
    const quote = lastCustomerMessage([{ role: 'user', content: 'x'.repeat(2000) }])!
    expect(quote.length).toBe(500)
    expect(quote.endsWith('…')).toBe(true)
  })
})

describe('buildHandoffMeta', () => {
  it('carries the reply count and the customer quote', () => {
    expect(
      buildHandoffMeta({
        messages: [{ role: 'user', content: 'agent please' }],
        replyCount: 2,
      }),
    ).toEqual({ replyCount: 2, lastCustomerMessage: 'agent please' })
  })

  it('keeps a reply count of zero (the bot bailed on the first inbound)', () => {
    expect(buildHandoffMeta({ replyCount: 0 })).toEqual({ replyCount: 0 })
  })

  it('records the cap for a reply-limit handoff', () => {
    expect(buildHandoffMeta({ max: 5 })).toEqual({ max: 5 })
  })

  it('reduces provider attempts to provider + code only', () => {
    expect(
      buildHandoffMeta({
        attempts: [
          { provider: 'gemini', error: { code: 'unavailable' } },
          { provider: 'anthropic', error: { code: 'timeout' } },
        ],
      }),
    ).toEqual({
      attempts: [
        { provider: 'gemini', code: 'unavailable' },
        { provider: 'anthropic', code: 'timeout' },
      ],
    })
  })

  it('omits keys with nothing to say', () => {
    expect(buildHandoffMeta({ messages: [], attempts: [] })).toEqual({})
  })
})
