import { describe, it, expect } from 'vitest'
import { hashKey, pickVariant } from './variant'

describe('pickVariant', () => {
  const variants = ['a', 'b', 'c']

  it('always gives the same key the same wording', () => {
    expect(pickVariant(variants, 'conv-1')).toBe(pickVariant(variants, 'conv-1'))
  })

  it('spreads different keys across every variant', () => {
    const seen = new Set<string | null>()
    for (let i = 0; i < 80; i++) seen.add(pickVariant(variants, `conv-${i}`))
    expect(seen.size).toBe(3)
  })

  it('ignores blank entries and returns null when nothing is usable', () => {
    expect(pickVariant(['', '  '], 'k')).toBeNull()
    expect(pickVariant([], 'k')).toBeNull()
    expect(pickVariant(['', 'only'], 'k')).toBe('only')
  })
})

describe('hashKey', () => {
  it('is stable and sensitive to the input', () => {
    expect(hashKey('abc')).toBe(hashKey('abc'))
    expect(hashKey('abc')).not.toBe(hashKey('abd'))
  })
})
