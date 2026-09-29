import { describe, it, expect } from 'vitest'
import { BEFORE_SEND_CHAIN_VERSION, BEFORE_SEND_GATES, runBeforeSend } from './gates'

const ctx = { optedOut: false, handingOff: false }

describe('chain contract', () => {
  it('locks order, length and version — change it on purpose, here first', () => {
    expect(BEFORE_SEND_CHAIN_VERSION).toBe(1)
    expect([...BEFORE_SEND_GATES]).toEqual([
      'opt_out',
      'reasoning_leak',
      'human_promise',
      'internal_vocabulary',
    ])
  })

  it('runs opt_out first even when later gates would also veto', () => {
    const v = runBeforeSend('Vou encaminhar para o time.', { optedOut: true, handingOff: false })
    expect(v?.gate).toBe('opt_out')
  })
})

describe('human_promise', () => {
  it.each([
    'Vou encaminhar seu caso para o time de suporte.',
    'Nossa equipe vai retornar em breve.',
    'Vou passar você para um atendente.',
    "I'll pass this to the team.",
  ])('vetoes: %s', (t) => {
    expect(runBeforeSend(t, ctx)?.gate).toBe('human_promise')
  })

  it.each([
    'Vou verificar seu pedido no sistema.',
    'Nossa equipe está sempre à disposição para ajudar.',
    'Vou te explicar como funciona o catálogo.',
  ])('does not veto the trap: %s', (t) => {
    expect(runBeforeSend(t, ctx)).toBeNull()
  })

  it('passes when the turn is already a handoff', () => {
    expect(runBeforeSend('Vou encaminhar para o time.', { optedOut: false, handingOff: true })).toBeNull()
  })
})

describe('internal_vocabulary', () => {
  it.each([
    'Erro: crm_list_webhook_sources falhou.',
    "Role 'agent' insufficient for this action",
    'MetaApiError: Param text.body must be at most 4096 characters',
    'Chamei book_appointment mas deu conflito.',
  ])('vetoes: %s', (t) => {
    expect(runBeforeSend(t, ctx)?.gate).toBe('internal_vocabulary')
  })

  it('does not ban the customer’s own stage words', () => {
    expect(runBeforeSend('Seu pedido está na etapa de aprovação do funil.', ctx)).toBeNull()
  })
})

describe('reasoning_leak', () => {
  it('vetoes a monologue', () => {
    const t =
      'Okay, let me break this down. The user is a client. According to the business context, my next message should ask for the site.'
    expect(runBeforeSend(t, ctx)?.gate).toBe('reasoning_leak')
  })
})
