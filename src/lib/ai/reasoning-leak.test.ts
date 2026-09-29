import { describe, it, expect } from 'vitest'
import { looksLikeReasoningLeak, stripThinkBlocks } from './reasoning-leak'

describe('stripThinkBlocks', () => {
  it('removes a closed think block and keeps the answer', () => {
    expect(stripThinkBlocks('<think>plan the reply</think>Olá! Como posso ajudar?')).toBe(
      'Olá! Como posso ajudar?',
    )
  })

  it('removes an unclosed block (truncated output)', () => {
    expect(stripThinkBlocks('Olá!<think>the user wants')).toBe('Olá!')
  })

  it('leaves normal text alone', () => {
    expect(stripThinkBlocks('Tudo certo por aqui.')).toBe('Tudo certo por aqui.')
  })
})

describe('looksLikeReasoningLeak', () => {
  it('flags the production leak (English monologue about the user)', () => {
    const leak =
      'Okay, let me break this down. The user is Raylson, who says he is a client. ' +
      'According to the business context, I should confirm the company. ' +
      'So my next message should ask for the site name before the handoff.'
    expect(looksLikeReasoningLeak(leak)).toBe(true)
  })

  it('flags a Portuguese monologue', () => {
    expect(
      looksLikeReasoningLeak(
        'Vamos analisar. O usuário quer suporte e minha próxima resposta deve pedir o nome do site.',
      ),
    ).toBe(true)
  })

  it('does not flag a normal reply that starts with "Okay"', () => {
    expect(looksLikeReasoningLeak('Okay! Já anotei seu pedido e te aviso quando sair.')).toBe(false)
  })

  it('does not flag a customer-facing reply mentioning a user account', () => {
    expect(
      looksLikeReasoningLeak('Certo! Para acessar, use o e-mail do usuário cadastrado no site.'),
    ).toBe(false)
  })

  it('needs the opener: an outside-view sentence alone is not enough', () => {
    expect(looksLikeReasoningLeak('Sua mensagem foi recebida; o usuário será avisado.')).toBe(false)
  })
})
