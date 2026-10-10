import { describe, expect, it } from 'vitest';
import { isUnsupportedPlaceholder, looksLikeAutomatedSender } from './automated-sender';

const MENU =
  'Para resolver sua solicitação de forma rápida e prática, acesse o Minha Claro e utilize o autoatendimento';
const at = (s: number) => new Date(Date.UTC(2026, 9, 10, 11, 0, s)).toISOString();
const bot = (s: number) => ({ sender_type: 'bot', created_at: at(s), content_text: 'Posso ajudar?' });
const customer = (s: number, text: string) => ({ sender_type: 'customer', created_at: at(s), content_text: text });

describe('looksLikeAutomatedSender', () => {
  it('flags long replies arriving seconds after ours (the carrier menu case)', () => {
    expect(
      looksLikeAutomatedSender([bot(0), customer(3, MENU), bot(20), customer(23, MENU + ' fatura')])
    ).toBe(true);
  });

  it('flags the same long message repeated', () => {
    expect(
      looksLikeAutomatedSender([customer(0, MENU), bot(30), customer(59, MENU), bot(90), customer(119, MENU)])
    ).toBe(true);
  });

  it('leaves a person alone: short fast replies, long slow ones', () => {
    expect(
      looksLikeAutomatedSender([
        bot(0),
        customer(2, 'ok'),
        bot(5),
        customer(7, 'sim'),
        bot(10),
        customer(55, 'Quero saber o preço do plano profissional para minha clínica, por favor'),
      ])
    ).toBe(false);
  });

  it('one fast long message is not enough', () => {
    expect(looksLikeAutomatedSender([bot(0), customer(3, MENU)])).toBe(false);
  });
});

describe('isUnsupportedPlaceholder', () => {
  it('matches only the placeholder', () => {
    expect(isUnsupportedPlaceholder('[Unsupported message type: unsupported]')).toBe(true);
    expect(isUnsupportedPlaceholder('Olá [Unsupported message type: x]')).toBe(false);
  });
});
