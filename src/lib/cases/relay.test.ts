import { describe, it, expect } from 'vitest'
import { relayMessages } from './relay'

describe('relayMessages', () => {
  it("ends on a user turn when the thread ends on the AI's own message", () => {
    const out = relayMessages([
      { role: 'user', content: 'Quero a segunda via' },
      { role: 'assistant', content: 'Abri um chamado' },
    ])
    expect(out).toHaveLength(3)
    expect(out[2].role).toBe('user')
  })
  it('leaves a thread that already ends on the customer alone', () => {
    const msgs = [{ role: 'user', content: 'Oi' }]
    expect(relayMessages(msgs)).toBe(msgs)
  })
  it('gives an empty thread a single cue', () => {
    expect(relayMessages([])).toHaveLength(1)
  })
})
