import { describe, it, expect, afterEach } from 'vitest'
import { aiReplyDebounceMs, waitForQuietPeriod } from './burst'

/** A db whose "newest customer message" and "message by wamid" answers
 *  are scripted per call. */
function fakeDb(script: { own?: string | null; newest: (string | null)[] }) {
  let newestCall = 0
  const db = {
    from: () => {
      const q: Record<string, unknown> = {}
      let byWamid = false
      q.select = () => q
      q.eq = (col: string) => {
        if (col === 'message_id') byWamid = true
        return q
      }
      q.order = () => q
      q.limit = () => q
      q.maybeSingle = () => {
        if (byWamid) {
          return Promise.resolve({ data: script.own ? { id: script.own } : null })
        }
        const id = script.newest[Math.min(newestCall++, script.newest.length - 1)]
        return Promise.resolve({ data: id ? { id } : null })
      }
      return q
    },
  }
  return db as never
}

const noSleep = () => Promise.resolve()

describe('waitForQuietPeriod', () => {
  it('answers when nothing newer arrived', async () => {
    const db = fakeDb({ own: 'm1', newest: ['m1'] })
    expect(
      await waitForQuietPeriod(db, { conversationId: 'c', inboundMessageId: 'w1', ms: 10, sleep: noSleep }),
    ).toBe('proceed')
  })

  it('steps aside when a newer customer message arrived during the wait', async () => {
    const db = fakeDb({ own: 'm1', newest: ['m2'] })
    expect(
      await waitForQuietPeriod(db, { conversationId: 'c', inboundMessageId: 'w1', ms: 10, sleep: noSleep }),
    ).toBe('superseded')
  })

  it('recognises a message that arrived BEFORE the dispatch looked', async () => {
    // Own message is m1 (by wamid) but m2 is already the newest.
    const db = fakeDb({ own: 'm1', newest: ['m2', 'm2'] })
    expect(
      await waitForQuietPeriod(db, { conversationId: 'c', inboundMessageId: 'w1', ms: 10, sleep: noSleep }),
    ).toBe('superseded')
  })

  it('without a wamid, uses the newest message at the start', async () => {
    const db = fakeDb({ newest: ['m1', 'm3'] })
    expect(await waitForQuietPeriod(db, { conversationId: 'c', ms: 10, sleep: noSleep })).toBe('superseded')
  })

  it('does not wait at all when the delay is 0', async () => {
    let slept = false
    const db = fakeDb({ newest: ['m1'] })
    const r = await waitForQuietPeriod(db, {
      conversationId: 'c',
      ms: 0,
      sleep: async () => {
        slept = true
      },
    })
    expect(r).toBe('proceed')
    expect(slept).toBe(false)
  })

  it('fails open: a broken lookup answers instead of dropping the customer', async () => {
    const db = {
      from: () => {
        throw new Error('db down')
      },
    } as never
    expect(await waitForQuietPeriod(db, { conversationId: 'c', ms: 10, sleep: noSleep })).toBe('proceed')
  })
})

describe('aiReplyDebounceMs', () => {
  const original = process.env.AI_REPLY_DEBOUNCE_MS
  afterEach(() => {
    if (original === undefined) delete process.env.AI_REPLY_DEBOUNCE_MS
    else process.env.AI_REPLY_DEBOUNCE_MS = original
  })

  it('defaults to a few seconds', () => {
    delete process.env.AI_REPLY_DEBOUNCE_MS
    expect(aiReplyDebounceMs()).toBe(4000)
  })
  it('0 disables it, junk falls back, big values are capped', () => {
    process.env.AI_REPLY_DEBOUNCE_MS = '0'
    expect(aiReplyDebounceMs()).toBe(0)
    process.env.AI_REPLY_DEBOUNCE_MS = 'abc'
    expect(aiReplyDebounceMs()).toBe(4000)
    process.env.AI_REPLY_DEBOUNCE_MS = '999999'
    expect(aiReplyDebounceMs()).toBe(15000)
  })
})
