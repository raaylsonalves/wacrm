import { describe, it, expect, vi, beforeEach } from 'vitest'

const store = vi.hoisted(() => ({
  openCase: vi.fn(),
  transitionCase: vi.fn(),
  notifyTeam: vi.fn(),
}))
vi.mock('@/lib/cases/store', () => store)

import { casesPromptSection, createCaseToolExecutor } from './cases'
import { promisesHumanFollowUp } from '../guardrails/gates'
import { relayInstruction } from '@/lib/cases/relay'

/** db whose human_cases lookup returns `found`. */
function fakeDb(found: unknown) {
  const q: Record<string, unknown> = {}
  for (const m of ['select', 'eq']) q[m] = () => q
  q.maybeSingle = () => Promise.resolve({ data: found })
  return { from: () => q } as never
}

const ctx = (found: unknown = null, onOpened?: () => void) =>
  createCaseToolExecutor({ db: fakeDb(found), accountId: 'a', conversationId: 'conv', contactId: 'k', onOpened })

beforeEach(() => {
  store.openCase.mockReset()
  store.transitionCase.mockReset()
  store.notifyTeam.mockReset()
})

describe('open_human_case', () => {
  it('opens a case and flags the turn', async () => {
    store.openCase.mockResolvedValue({ ok: true, caseId: 'case-1' })
    const flag = vi.fn()
    const r = JSON.parse(
      await ctx(null, flag)('open_human_case', { title: 'Liberar acesso', summary: 'Cliente sem acesso', blocker: 'Liberar no painel' }),
    )
    expect(r).toMatchObject({ success: true, case_id: 'case-1' })
    expect(flag).toHaveBeenCalled()
    expect(store.openCase.mock.calls[0][1]).toMatchObject({ conversationId: 'conv', openedBy: 'ai' })
  })

  it('rejects unknown fields and oversized text', async () => {
    const extra = JSON.parse(await ctx()('open_human_case', { title: 't', summary: 's', blocker: 'b', __proto__x: 1 }))
    expect(extra.error).toContain('Unknown field')
    const long = JSON.parse(await ctx()('open_human_case', { title: 'x'.repeat(121), summary: 's', blocker: 'b' }))
    expect(long).toHaveProperty('error')
    expect(store.openCase).not.toHaveBeenCalled()
  })
})

describe('provide_case_update', () => {
  it('refuses a case of another conversation', async () => {
    const r = JSON.parse(await ctx(null)('provide_case_update', { case_id: 'x', info: 'CPF 123' }))
    expect(r.error).toContain('No such case')
    expect(store.transitionCase).not.toHaveBeenCalled()
  })

  it('moves the case back to the team and notifies', async () => {
    store.transitionCase.mockResolvedValue({ ok: true, noop: false, row: {} })
    const r = JSON.parse(
      await ctx({ id: 'c1', title: 'Reembolso', conversation_id: 'conv' })('provide_case_update', {
        case_id: 'c1',
        info: 'Pedido 998',
      }),
    )
    expect(r.success).toBe(true)
    expect(store.transitionCase.mock.calls[0][1]).toMatchObject({ action: 'lead_provided', actorKind: 'ai' })
    expect(store.notifyTeam.mock.calls[0][1]).toMatchObject({ type: 'case_lead_replied' })
  })
})

describe('prompt + fail-safe detector + relay', () => {
  it('lists open cases with what the team needs', () => {
    const p = casesPromptSection([
      { id: 'c1', title: 'Reembolso', status: 'awaiting_lead', pending_note: 'número do pedido' },
    ])
    expect(p).toContain('c1')
    expect(p).toContain('número do pedido')
  })

  it.each([
    'Vou verificar com a equipe e te retorno.',
    'Vou passar para o time financeiro.',
    'Nossa equipe vai retornar ainda hoje.',
  ])('detects a promise: %s', (t) => expect(promisesHumanFollowUp(t)).toBe(true))

  it.each(['Vou verificar seu pedido no sistema.', 'Nossa equipe está sempre à disposição.'])(
    'no promise: %s',
    (t) => expect(promisesHumanFollowUp(t)).toBe(false),
  )

  it('the relay instruction forbids disclosing internal notes', () => {
    expect(relayInstruction('done', 'X', 'liberado no painel admin')).toContain('never quote or reveal internal notes')
    expect(relayInstruction('need_info', 'X', 'CPF')).toContain('Ask the customer')
  })
})
