import { describe, it, expect } from 'vitest'
import {
  SUGGESTED_HANDOFF_KEYWORDS,
  cleanHandoffKeywords,
  matchHandoffKeyword,
  normalizeForKeyword,
} from './handoff-keywords'

describe('matchHandoffKeyword', () => {
  const kw = ['atendente', 'falar com humano']

  it('matches a whole word, ignoring case, accents and punctuation', () => {
    expect(matchHandoffKeyword('Quero um ATENDENTE, por favor!', kw)).toBe('atendente')
    expect(matchHandoffKeyword('falar com HUMANO?', kw)).toBe('falar com humano')
    expect(matchHandoffKeyword('quero falar com humáno', ['falar com humano'])).toBe('falar com humano')
    expect(matchHandoffKeyword('Atendénte', ['atendente'])).toBe('atendente')
  })

  it('does not fire inside a longer word', () => {
    expect(matchHandoffKeyword('os atendentes-modelo são ótimos', kw)).toBeNull()
    expect(matchHandoffKeyword('desatendente', kw)).toBeNull()
  })

  it('needs the whole phrase, not one of its words', () => {
    expect(matchHandoffKeyword('posso falar com o gerente', kw)).toBeNull()
  })

  it('never matches on empty input or an empty list', () => {
    expect(matchHandoffKeyword('', kw)).toBeNull()
    expect(matchHandoffKeyword('   ', kw)).toBeNull()
    expect(matchHandoffKeyword('atendente', [])).toBeNull()
    expect(matchHandoffKeyword('atendente', ['', '  '])).toBeNull()
  })

  it('handles non-Latin scripts', () => {
    expect(matchHandoffKeyword('상담원 연결해 주세요', ['상담원'])).toBe('상담원')
  })
})

describe('cleanHandoffKeywords', () => {
  it('trims, dedupes after normalizing, and drops blanks and non-strings', () => {
    expect(
      cleanHandoffKeywords([' Atendente ', 'atendente', 'ATENDENTE!', '', 5, null, 'pessoa real']),
    ).toEqual(['Atendente', 'pessoa real'])
  })

  it('is empty for anything that is not a list', () => {
    expect(cleanHandoffKeywords('atendente')).toEqual([])
    expect(cleanHandoffKeywords(undefined)).toEqual([])
  })

  it('caps the count and the length of each entry', () => {
    const many = Array.from({ length: 60 }, (_, i) => `frase ${i}`)
    expect(cleanHandoffKeywords(many)).toHaveLength(30)
    expect(cleanHandoffKeywords(['x'.repeat(200)])[0]).toHaveLength(80)
  })
})

describe('suggestions', () => {
  it('every suggestion matches itself (so the starter list actually works)', () => {
    for (const s of SUGGESTED_HANDOFF_KEYWORDS) {
      expect(matchHandoffKeyword(`oi, ${s} por favor`, [s])).toBe(s)
    }
  })

  it('normalizes to a stable form', () => {
    expect(normalizeForKeyword('  Olá,   MUNDO!! ')).toBe('ola mundo')
  })
})
