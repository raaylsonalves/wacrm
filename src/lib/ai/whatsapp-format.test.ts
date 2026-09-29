import { describe, it, expect } from 'vitest'
import { toSpeechText, toWhatsAppFormat } from './whatsapp-format'

describe('toWhatsAppFormat', () => {
  it('turns Markdown bold into WhatsApp bold', () => {
    expect(toWhatsAppFormat('1. **Sistemas sob medida**: plataformas')).toBe(
      '1. *Sistemas sob medida*: plataformas',
    )
    expect(toWhatsAppFormat('__forte__')).toBe('*forte*')
  })
  it('keeps WhatsApp formatting that is already right', () => {
    expect(toWhatsAppFormat('Olá *Raylson*, _tudo bem_?')).toBe('Olá *Raylson*, _tudo bem_?')
  })
  it('headings, strike, links and * bullets', () => {
    expect(toWhatsAppFormat('## Planos')).toBe('*Planos*')
    expect(toWhatsAppFormat('~~R$ 100~~')).toBe('~R$ 100~')
    expect(toWhatsAppFormat('[site](https://nordia.com.br)')).toBe('site: https://nordia.com.br')
    expect(toWhatsAppFormat('* um\n* dois')).toBe('• um\n• dois')
  })
  it('leaves a plain multiplication alone', () => {
    expect(toWhatsAppFormat('2 * 3 = 6')).toBe('2 * 3 = 6')
  })
})

describe('toSpeechText', () => {
  it('drops symbols and URLs', () => {
    expect(toSpeechText('1. **Sistemas sob medida**: veja [aqui](https://x.com)')).toBe(
      '1. Sistemas sob medida: veja aqui:',
    )
    expect(toSpeechText('- um\n- dois')).toBe('um\ndois')
  })
})
