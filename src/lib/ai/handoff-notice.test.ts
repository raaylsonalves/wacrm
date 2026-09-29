import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import {
  dictFromMessages,
  handoffNoticeText,
  hashKey,
  isTeamOnline,
  type HandoffNoticeDict,
} from './handoff-notice'

const LOCALES = ['en', 'pt', 'es', 'ko'] as const

function dictFor(locale: string): HandoffNoticeDict {
  const messages = JSON.parse(
    readFileSync(join(process.cwd(), 'messages', `${locale}.json`), 'utf8'),
  )
  const dict = dictFromMessages(messages.AiHandoffNotice)
  if (!dict) throw new Error(`${locale}: AiHandoffNotice missing`)
  return dict
}

const DICT: HandoffNoticeDict = {
  online: ['on-1', 'on-2', 'on-3'],
  offline: ['off-1', 'off-2', 'off-3'],
  optOut: ['out-1', 'out-2'],
}

const base = { leadKey: 'conv-1', dict: DICT }

describe('handoffNoticeText', () => {
  it('confirms an opt-out and never says a person is coming', () => {
    const text = handoffNoticeText({ ...base, optOut: true, teamOnline: true })
    expect(DICT.optOut).toContain(text)
  })

  it('uses the online copy only when someone is actually online', () => {
    const on = handoffNoticeText({ ...base, optOut: false, teamOnline: true })
    const off = handoffNoticeText({ ...base, optOut: false, teamOnline: false })
    expect(DICT.online).toContain(on)
    expect(DICT.offline).toContain(off)
  })

  it('always gives the same conversation the same wording', () => {
    const args = { ...base, optOut: false, teamOnline: false }
    expect(handoffNoticeText(args)).toBe(handoffNoticeText(args))
  })

  it('spreads different conversations across the variants', () => {
    const seen = new Set<string | null>()
    for (let i = 0; i < 60; i++) {
      seen.add(
        handoffNoticeText({
          ...base,
          leadKey: `conv-${i}`,
          optOut: false,
          teamOnline: true,
        }),
      )
    }
    expect(seen.size).toBe(DICT.online.length)
  })

  it('returns null rather than a raw key when the dictionary is empty', () => {
    expect(
      handoffNoticeText({
        ...base,
        dict: { online: [], offline: [], optOut: [] },
        optOut: false,
        teamOnline: true,
      }),
    ).toBeNull()
  })
})

describe('hashKey', () => {
  it('is stable', () => {
    expect(hashKey('abc')).toBe(hashKey('abc'))
    expect(hashKey('abc')).not.toBe(hashKey('abd'))
  })
})

describe('dictFromMessages', () => {
  it('orders variants by key and drops blanks', () => {
    expect(
      dictFromMessages({
        online: { v2: 'b', v1: 'a', v3: '  ' },
        offline: { v1: 'c' },
        optOut: {},
      }),
    ).toEqual({ online: ['a', 'b'], offline: ['c'], optOut: [] })
  })

  it('is null for a missing node', () => {
    expect(dictFromMessages(undefined)).toBeNull()
  })
})

// Word-set Jaccard similarity: variants that only swap a synonym would
// score near 1 and still read as the same sentence to WhatsApp's
// spam heuristics. Whitespace tokenisation is crude for Korean, but it
// still catches copy-paste variants.
function similarity(a: string, b: string): number {
  const wa = new Set(a.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
  const wb = new Set(b.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
  const inter = [...wa].filter((w) => wb.has(w)).length
  return inter / (wa.size + wb.size - inter)
}

describe.each(LOCALES)('shipped notice copy (%s)', (locale) => {
  const dict = dictFor(locale)

  it('has variants for every situation', () => {
    expect(dict.online.length).toBeGreaterThanOrEqual(3)
    expect(dict.offline.length).toBeGreaterThanOrEqual(3)
    expect(dict.optOut.length).toBeGreaterThanOrEqual(2)
  })

  it('has variants that differ in structure, not just a synonym', () => {
    for (const pool of [dict.online, dict.offline, dict.optOut]) {
      for (let i = 0; i < pool.length; i++) {
        for (let j = i + 1; j < pool.length; j++) {
          expect(similarity(pool[i], pool[j])).toBeLessThan(0.5)
        }
      }
    }
  })

  it('never promises an immediate reply when nobody is online', () => {
    // "shortly" / "soon" style promises belong to the online pool only.
    const promise: Record<string, RegExp> = {
      en: /\b(shortly|right now|next)\b/i,
      pt: /\b(em instantes|agora|em breve|em seguida)\b/i,
      es: /\b(en breve|ahora|pronto|a continuación)\b/i,
      ko: /(곧|지금)/,
    }
    for (const text of dict.offline) {
      // "Nobody is online at the moment" is the honest use of "now".
      const cleaned = text.replace(/(at the moment|no momento|ahora mismo|지금은)/gi, '')
      expect(cleaned).not.toMatch(promise[locale])
    }
  })
})

describe('isTeamOnline', () => {
  const dbReturning = (result: { data: unknown } | Error) =>
    ({
      from: () => {
        const chain = {
          select: () => chain,
          eq: () => chain,
          gte: () => chain,
          limit: () =>
            result instanceof Error
              ? Promise.reject(result)
              : Promise.resolve(result),
        }
        return chain
      },
    }) as never

  it('is true when a fresh online row exists', async () => {
    expect(await isTeamOnline(dbReturning({ data: [{ user_id: 'u' }] }), 'a')).toBe(true)
  })

  it('is false with no rows and on any failure', async () => {
    expect(await isTeamOnline(dbReturning({ data: [] }), 'a')).toBe(false)
    expect(await isTeamOnline(dbReturning(new Error('boom')), 'a')).toBe(false)
  })
})
