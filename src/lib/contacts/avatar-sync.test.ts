import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: (v: string) => `dec:${v}` }))

import { syncContactAvatars } from './avatar-sync'

/** A chainable fake: every builder method returns the chain; awaiting it
 *  (or .maybeSingle()) yields the table's scripted result. */
function fakeDb(opts: { rows: unknown[]; channelStatus?: string; uploadError?: string }) {
  const updates: Record<string, unknown>[] = []
  const uploads: string[] = []
  const chain = (result: unknown) => {
    const q: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'is', 'not', 'or', 'order', 'limit']) q[m] = () => q
    q.maybeSingle = () => Promise.resolve({ data: result })
    q.then = (r: (v: unknown) => unknown) => Promise.resolve({ data: result, error: null }).then(r)
    return q
  }
  const db = {
    from: (table: string) => {
      if (table === 'conversations') return chain(opts.rows)
      if (table === 'whatsapp_waha_channels')
        return chain({
          waha_base_url: 'http://waha',
          waha_api_key: 'k',
          waha_session_name: 's',
          status: opts.channelStatus ?? 'connected',
        })
      return {
        update: (p: Record<string, unknown>) => {
          updates.push(p)
          return chain(null)
        },
      }
    },
    storage: {
      from: () => ({
        upload: (path: string) => {
          uploads.push(path)
          return Promise.resolve({ error: opts.uploadError ? { message: opts.uploadError } : null })
        },
        getPublicUrl: (path: string) => ({ data: { publicUrl: `https://cdn/${path}` } }),
      }),
    },
  }
  return { db: db as never, updates, uploads }
}

const row = {
  contact_id: 'c1',
  whatsapp_channel_id: 'ch1',
  account_id: 'a1',
  contact: { id: 'c1', phone: '5511987654321', anonymized_at: null, avatar_updated_at: null },
}
const now = new Date('2026-09-29T12:00:00Z')
const okImage = vi.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => new Uint8Array([1, 2]).buffer })

describe('syncContactAvatars', () => {
  it('stores the FILE and points avatar_url at it, versioned', async () => {
    const { db, updates, uploads } = fakeDb({ rows: [row] })
    const lookup = vi.fn().mockResolvedValue('https://pps.whatsapp.net/x.jpg?oe=abc')
    const r = await syncContactAvatars(db, now, { lookup, fetchImage: okImage as never })
    expect(r).toMatchObject({ updated: 1 })
    expect(lookup.mock.calls[0][3]).toBe('5511987654321@c.us')
    expect(uploads[0]).toContain('avatars')
    expect(String(updates[0].avatar_url)).toMatch(/^https:\/\/cdn\/.*\?v=\d+$/)
    expect(updates[0].avatar_url).not.toContain('whatsapp.net')
  })

  it('no photo: stamps the lookup so it is not retried every run', async () => {
    const { db, updates } = fakeDb({ rows: [row] })
    const r = await syncContactAvatars(db, now, { lookup: vi.fn().mockResolvedValue(null), fetchImage: okImage as never })
    expect(r).toMatchObject({ none: 1 })
    expect(updates[0]).toEqual({ avatar_updated_at: now.toISOString() })
  })

  it('a disconnected number is skipped without stamping (retried later)', async () => {
    const { db, updates } = fakeDb({ rows: [row], channelStatus: 'disconnected' })
    const lookup = vi.fn()
    await syncContactAvatars(db, now, { lookup, fetchImage: okImage as never })
    expect(lookup).not.toHaveBeenCalled()
    expect(updates).toHaveLength(0)
  })

  it('a failed upload keeps the old photo and stamps', async () => {
    const { db, updates } = fakeDb({ rows: [row], uploadError: 'nope' })
    const r = await syncContactAvatars(db, now, {
      lookup: vi.fn().mockResolvedValue('https://x/y.jpg'),
      fetchImage: okImage as never,
    })
    expect(r).toMatchObject({ failed: 1 })
    expect(updates[0]).not.toHaveProperty('avatar_url')
  })
})

describe('syncContactAvatars — selection', () => {
  it('never looks up an anonymized contact, nor one refreshed recently', async () => {
    const anon = { ...row, contact: { ...row.contact, anonymized_at: '2026-09-01T00:00:00Z' } }
    const fresh = { ...row, contact: { ...row.contact, avatar_updated_at: '2026-09-28T00:00:00Z' } }
    const { db } = fakeDb({ rows: [anon, fresh] })
    const lookup = vi.fn()
    const r = await syncContactAvatars(db, now, { lookup, fetchImage: okImage as never })
    expect(r.looked).toBe(0)
    expect(lookup).not.toHaveBeenCalled()
  })
})
