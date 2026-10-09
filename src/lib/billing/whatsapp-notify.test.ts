import { describe, expect, it } from 'vitest';
import {
  amountText,
  billingTemplateFor,
  normalizeOwnerPhone,
} from './whatsapp-notify';

const CTX = { firstName: 'Raylson', plan: 'Profissional', accountName: 'Estetica Teste' };

describe('normalizeOwnerPhone', () => {
  it('adds 55 to a local Brazilian number', () => {
    expect(normalizeOwnerPhone('(11) 98765-4321')).toBe('5511987654321');
    expect(normalizeOwnerPhone('11 3456-7890')).toBe('551134567890');
  });
  it('keeps a number that already has the country code', () => {
    expect(normalizeOwnerPhone('+55 11 98765-4321')).toBe('5511987654321');
  });
  it('rejects what cannot be a phone', () => {
    expect(normalizeOwnerPhone('123')).toBeNull();
    expect(normalizeOwnerPhone(undefined)).toBeNull();
  });
});

describe('billingTemplateFor', () => {
  it('fills the payment receipt in the template order', () => {
    const tpl = billingTemplateFor(
      {
        kind: 'paid',
        amountCents: 39700,
        method: 'pix',
        periodEnd: new Date('2026-11-09T15:00:00Z'),
        finished: false,
      },
      CTX
    );
    expect(tpl).toEqual({
      name: 'nordia_pagamento_confirmado',
      params: ['Raylson', 'Profissional', amountText(39700), 'Pix', '09/11/2026'],
    });
  });

  it('has no next charge on the last installment', () => {
    const tpl = billingTemplateFor(
      { kind: 'paid', amountCents: 100, method: 'card', periodEnd: new Date(), finished: true },
      CTX
    );
    expect(tpl?.params[4]).toBe('—');
  });

  it('maps the reminder, the decline and the end', () => {
    expect(
      billingTemplateFor({ kind: 'pix_due', amountCents: 100, dueAt: new Date(), ticketUrl: null }, CTX)
        ?.name
    ).toBe('nordia_lembrete_vencimento');
    expect(
      billingTemplateFor({ kind: 'card_declined', amountCents: 100, graceUntil: new Date() }, CTX)
        ?.params
    ).toHaveLength(4);
    expect(billingTemplateFor({ kind: 'ended' }, CTX)).toEqual({
      name: 'nordia_acesso_encerrado',
      params: ['Raylson', 'Estetica Teste'],
    });
  });

  it('sends nothing for an overdue Pix (no approved template)', () => {
    expect(
      billingTemplateFor({ kind: 'past_due', amountCents: 100, graceUntil: new Date() }, CTX)
    ).toBeNull();
  });
});
