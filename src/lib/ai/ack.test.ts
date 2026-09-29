import { describe, it, expect } from 'vitest'
import { classifyAcknowledgment, shouldSkipAcknowledgment } from './ack'

describe('classifyAcknowledgment', () => {
  it.each(['ok', 'Ok!', 'OK.', 'blz', 'Beleza', 'certo', 'entendi', 'pode ser', 'tudo bem', 'combinado', 'ok 👍'])(
    'ok: %s',
    (t) => expect(classifyAcknowledgment(t)).toBe('ok'),
  )

  it.each(['👍', '🙏🙏', '👌', '👍🏽', '❤️', '😊'])('ok (emoji only): %s', (t) =>
    expect(classifyAcknowledgment(t)).toBe('ok'),
  )

  it.each(['obrigado', 'Obrigada!', 'valeu', 'vlw', 'muito obrigado', 'ok obrigado', 'thank you', 'gracias', 'obrigado 🙏'])(
    'thanks: %s',
    (t) => expect(classifyAcknowledgment(t)).toBe('thanks'),
  )

  it.each([
    'ok, mas quanto custa?',
    'ok e o prazo?',
    'certo?',
    'sim, quero o plano anual',
    'não',
    'oi',
    'bom dia',
    'muito',
    'you',
    '😡',
    '❓',
    '👎',
    'ok ok ok ok ok ok',
    '',
    '   ',
  ])('not an acknowledgment: %j', (t) => expect(classifyAcknowledgment(t)).toBeNull())
})

describe('shouldSkipAcknowledgment', () => {
  const statement = { contentType: 'text', text: 'Pronto, seu pedido foi registrado.' }

  it('skips an ok after a statement the AI already made', () => {
    expect(shouldSkipAcknowledgment({ text: 'ok', aiReplyCount: 2, lastBusinessMessage: statement })).toBe('ok')
    expect(shouldSkipAcknowledgment({ text: 'obrigado', aiReplyCount: 1, lastBusinessMessage: statement })).toBe('thanks')
  })

  it('never skips an ok that answers a question', () => {
    expect(
      shouldSkipAcknowledgment({
        text: 'ok',
        aiReplyCount: 2,
        lastBusinessMessage: { contentType: 'text', text: 'Confirma o horário das 15h?' },
      }),
    ).toBeNull()
  })

  it('never skips a tap on / after an interactive prompt', () => {
    expect(
      shouldSkipAcknowledgment({
        text: 'ok',
        aiReplyCount: 2,
        lastBusinessMessage: { contentType: 'interactive', text: 'Escolha um horário' },
      }),
    ).toBeNull()
  })

  it('answers the very first message (no AI reply yet)', () => {
    expect(shouldSkipAcknowledgment({ text: 'ok', aiReplyCount: 0, lastBusinessMessage: statement })).toBeNull()
  })

  it('does not skip when the business never wrote anything', () => {
    expect(shouldSkipAcknowledgment({ text: 'ok', aiReplyCount: 3, lastBusinessMessage: null })).toBeNull()
  })

  it('a real question is never skipped', () => {
    expect(shouldSkipAcknowledgment({ text: 'quanto custa?', aiReplyCount: 3, lastBusinessMessage: statement })).toBeNull()
  })
})
