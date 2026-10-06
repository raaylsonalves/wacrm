import { describe, expect, it } from 'vitest';
import { interestTag, parseLead, toE164BR } from './lead';

describe('toE164BR', () => {
  it('accepts local mobile and landline formats', () => {
    expect(toE164BR('(85) 99999-0000')).toBe('+5585999990000');
    expect(toE164BR('85 3222-1111')).toBe('+558532221111');
  });
  it('keeps an explicit 55 country code', () => {
    expect(toE164BR('+55 85 99999-0000')).toBe('+5585999990000');
  });
  it('rejects short or foreign numbers', () => {
    expect(toE164BR('99999-0000')).toBeNull();
    expect(toE164BR('+1 415 555 0123')).toBeNull();
  });
});

describe('parseLead', () => {
  it('normalizes name and falls back to the first interest', () => {
    const r = parseLead({
      name: '  Ana   Lima ',
      phone: '85999990000',
      interest: 'nope',
    });
    expect(r).toEqual({
      ok: true,
      lead: {
        name: 'Ana Lima',
        phone: '+5585999990000',
        interest: 'Landing page',
      },
    });
  });
  it('rejects a missing phone', () => {
    expect(parseLead({ name: 'x' })).toEqual({
      ok: false,
      error: 'invalid_phone',
    });
    expect(parseLead(null)).toEqual({ ok: false, error: 'invalid_body' });
  });
});

describe('interestTag', () => {
  it('slugifies without accents', () => {
    expect(interestTag('Implantação do CRM')).toBe(
      'interesse:implantacao-do-crm'
    );
    expect(interestTag('Integração')).toBe('interesse:integracao');
  });
});
