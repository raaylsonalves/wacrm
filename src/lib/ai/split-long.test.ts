import { describe, it, expect } from 'vitest'
import { WHATSAPP_TEXT_LIMIT, splitLongText } from './split-long'

describe('splitLongText', () => {
  it('leaves a short text alone, trimmed', () => {
    expect(splitLongText('  oi, tudo bem?  ')).toEqual(['oi, tudo bem?'])
  })

  it('returns nothing for blank input', () => {
    expect(splitLongText('   ')).toEqual([])
  })

  it('keeps every chunk within the limit and loses no words', () => {
    // The production case: a ~4.4k answer that Meta refused whole.
    const paragraph = 'Esta é uma frase de exemplo com bastante conteúdo. '.repeat(20).trim()
    const text = Array.from({ length: 5 }, () => paragraph).join('\n\n')
    expect(text.length).toBeGreaterThan(4096)

    const parts = splitLongText(text)
    expect(parts.length).toBeGreaterThan(1)
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(WHATSAPP_TEXT_LIMIT)
    const words = (s: string) => s.split(/\s+/).filter(Boolean)
    expect(parts.flatMap(words)).toEqual(words(text))
  })

  it('prefers a paragraph break over cutting mid-sentence', () => {
    const a = 'a'.repeat(60)
    const text = `${a}\n\n${'b'.repeat(60)}`
    expect(splitLongText(text, 100)).toEqual([a, 'b'.repeat(60)])
  })

  it('falls back to a sentence end, then a space', () => {
    const text = `${'palavra '.repeat(10)}fim da frase. ${'outra '.repeat(20)}`.trim()
    const parts = splitLongText(text, 100)
    expect(parts.every((p) => p.length <= 100)).toBe(true)
    expect(parts[0].endsWith('frase.')).toBe(true)
  })

  it('hard-cuts a run with no boundary, without splitting an emoji', () => {
    const emoji = '😀' // two UTF-16 units
    const text = emoji.repeat(30)
    const parts = splitLongText(text, 11)
    for (const p of parts) {
      expect(p.length).toBeLessThanOrEqual(11)
      expect([...p].every((ch) => ch === emoji)).toBe(true)
    }
    expect(parts.join('')).toBe(text)
  })

  it('handles a single unbroken string (a long URL)', () => {
    const parts = splitLongText('x'.repeat(9000))
    expect(parts.every((p) => p.length <= WHATSAPP_TEXT_LIMIT)).toBe(true)
    expect(parts.join('')).toBe('x'.repeat(9000))
  })
})
