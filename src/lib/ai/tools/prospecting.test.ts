import { describe, it, expect, vi } from 'vitest'
import { createProspectingToolExecutor } from './prospecting'

function fakeDb(deal: { notes: string | null } | null) {
  const updates: Record<string, unknown>[] = []
  const chain = (result: unknown) => {
    const q: Record<string, unknown> = {}
    q.select = () => q
    q.eq = () => q
    q.maybeSingle = () => Promise.resolve({ data: result })
    return q
  }
  const db = {
    from: vi.fn(() => ({
      ...chain(deal),
      update: (p: Record<string, unknown>) => {
        updates.push(p)
        const q: Record<string, unknown> = {}
        q.eq = () => q
        q.then = (r: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(r)
        return q
      },
    })),
  }
  return { db: db as never, updates }
}
const ctx = { dealId: 'd1', qualifiedStageId: 'stage-q', criteria: 'x' }

describe('qualify_lead', () => {
  it('moves only this deal to the campaign qualified stage, noting the summary', async () => {
    const { db, updates } = fakeDb({ notes: 'Campanha' })
    const run = createProspectingToolExecutor({ db, accountId: 'a', ctx })
    expect(JSON.parse(await run('qualify_lead', { summary: 'Tem oficina e quer site.' }))).toEqual({ success: true })
    expect(updates[0]).toMatchObject({ stage_id: 'stage-q' })
    expect(String(updates[0].notes)).toContain('Tem oficina e quer site.')
  })
  it('refuses without a summary, and for a deal outside the account', async () => {
    const run = createProspectingToolExecutor({ db: fakeDb({ notes: null }).db, accountId: 'a', ctx })
    expect(JSON.parse(await run('qualify_lead', {}))).toHaveProperty('error')
    const run2 = createProspectingToolExecutor({ db: fakeDb(null).db, accountId: 'a', ctx })
    expect(JSON.parse(await run2('qualify_lead', { summary: 'ok' }))).toEqual({ error: 'deal not found' })
  })
})
