import { describe, expect, it } from 'vitest';
import { buildBillingEmail, formatBRL } from './billing';

describe('buildBillingEmail', () => {
  it('formats a paid receipt with the next charge date', () => {
    const e = buildBillingEmail(
      {
        kind: 'paid',
        amountCents: 19700,
        method: 'pix',
        periodEnd: new Date('2026-11-09T15:00:00Z'),
        finished: false,
      },
      'Estética <Teste>'
    );
    expect(e.subject).toContain('Pagamento confirmado');
    expect(e.html).toContain(formatBRL(19700));
    expect(e.html).toContain('Próxima cobrança');
    expect(e.html).toContain('09/11/2026');
    // account names are escaped
    expect(e.html).toContain('Estética &lt;Teste&gt;');
    expect(e.html).not.toContain('<Teste>');
  });

  it('says "access until" on the last installment', () => {
    const e = buildBillingEmail(
      { kind: 'paid', amountCents: 100, method: 'card', periodEnd: new Date(), finished: true },
      null
    );
    expect(e.html).toContain('Acesso até');
    expect(e.html).toContain('Cartão de crédito');
  });

  it('links the Pix ticket when there is one, else the billing page', () => {
    const withTicket = buildBillingEmail(
      { kind: 'pix_due', amountCents: 100, dueAt: new Date(), ticketUrl: 'https://mp.example/t' },
      null
    );
    expect(withTicket.html).toContain('https://mp.example/t');
    const without = buildBillingEmail(
      { kind: 'pix_due', amountCents: 100, dueAt: new Date(), ticketUrl: null },
      null
    );
    expect(without.html).toContain('/settings?tab=billing');
  });

  it('builds every kind with a subject and a plain-text part', () => {
    for (const e of [
      buildBillingEmail({ kind: 'card_declined', amountCents: 100 }, null),
      buildBillingEmail({ kind: 'past_due', amountCents: 100, graceUntil: new Date() }, null),
      buildBillingEmail({ kind: 'ended' }, null),
    ]) {
      expect(e.subject.length).toBeGreaterThan(0);
      expect(e.text).toContain('/settings?tab=billing');
    }
  });
});
