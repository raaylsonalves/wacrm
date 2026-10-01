import { describe, it, expect } from 'vitest'
import { buildSystemPrompt } from './defaults'

const base = {
  userPrompt: 'Somos uma barbearia. Atendemos de terça a sábado.',
  mode: 'auto_reply' as const,
  agendaToolsEnabled: true,
}

describe('buildSystemPrompt — order (prefix caching)', () => {
  it('puts the per-customer and per-question parts last', () => {
    const p = buildSystemPrompt({
      ...base,
      contactName: 'Marina',
      knowledge: ['Corte custa R$ 50.'],
    })
    const business = p.indexOf('Business context and instructions')
    const agenda = p.indexOf('offer_slots')
    const name = p.indexOf('Marina')
    const kb = p.indexOf('Knowledge base')
    expect(business).toBeGreaterThan(-1)
    expect(agenda).toBeGreaterThan(-1)
    expect(name).toBeGreaterThan(business)
    expect(name).toBeGreaterThan(agenda)
    expect(kb).toBeGreaterThan(name)
  })

  it('is byte-identical up to the business context for two different customers', () => {
    const a = buildSystemPrompt({ ...base, contactName: 'Marina', knowledge: ['A'] })
    const b = buildSystemPrompt({ ...base, contactName: 'João', knowledge: ['B'] })
    const cut = a.indexOf('Business context and instructions') + base.userPrompt.length
    expect(a.slice(0, cut)).toBe(b.slice(0, cut))
  })

  it('still asks for the name when it is unknown', () => {
    const p = buildSystemPrompt({ ...base, contactName: null })
    expect(p).toContain("You don't know this customer's name yet")
    expect(p.indexOf("You don't know")).toBeGreaterThan(p.indexOf('Business context and instructions'))
  })

  it('draft mode carries no auto-reply-only sections', () => {
    const p = buildSystemPrompt({ userPrompt: 'x', mode: 'draft', contactName: 'Marina' })
    expect(p).not.toContain('Marina')
  })
})

describe('buildSystemPrompt — unknown terms', () => {
  it('tells the model to ask about terms it does not know, and that transcripts can be wrong', () => {
    const p = buildSystemPrompt({ userPrompt: 'x', mode: 'auto_reply' })
    expect(p).toContain('do not describe or explain it')
    expect(p).toContain('[áudio transcrito]')
  })
})

describe('buildSystemPrompt — scheduling is not a handoff', () => {
  it('tells the model to book instead of handing off when agenda tools are on', () => {
    const p = buildSystemPrompt({ ...base, knowledge: ['Consignado desconta da folha.'] })
    expect(p).toContain('is NOT a reason to reply [[HANDOFF]]')
    expect(p).toContain('scheduling requests are the exception')
  })

  it('asks when before listing, and says the list is not everything', () => {
    const p = buildSystemPrompt(base)
    expect(p).toContain('first ask in one short message which day or period')
    expect(p).toContain('The list is a set of suggestions, not everything that is free')
  })

  it('says nothing about scheduling when agenda tools are off', () => {
    const p = buildSystemPrompt({ userPrompt: 'x', mode: 'auto_reply', knowledge: ['A'] })
    expect(p).not.toContain('Scheduling is something you do yourself')
    expect(p).not.toContain('scheduling requests are the exception')
  })
})

it('tells the model its own earlier messages are not a source', () => {
  expect(buildSystemPrompt({ userPrompt: 'x', mode: 'auto_reply' })).toContain('NOT a source of truth')
})

it('teaches the model to explain a sent template instead of handing off', () => {
  expect(buildSystemPrompt({ userPrompt: 'x', mode: 'auto_reply' })).toContain('[modelo enviado]')
})
