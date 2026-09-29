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
