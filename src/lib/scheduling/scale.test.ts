import { describe, expect, it } from 'vitest';
import {
  createScaleClient,
  idempotencyKey,
  parseScaleSlotId,
  phoneDigits,
  pickSlots,
  priceText,
  scaleSlotId,
  ScaleError,
  slotLabel,
} from './scale';

describe('slot ids', () => {
  it('round-trips everything book_appointment needs', () => {
    const id = scaleSlotId('b-1', '2026-10-16T19:30:00', ['s-1', 's-2']);
    expect(id).toBe('scale|b-1|2026-10-16T19:30|s-1,s-2');
    expect(parseScaleSlotId(id)).toEqual({
      professionalId: 'b-1',
      inicio: '2026-10-16T19:30',
      serviceIds: ['s-1', 's-2'],
    });
    expect(parseScaleSlotId('slot:2026-10-16T19:30:00.000Z')).toBeNull();
  });

  it('labels fit a WhatsApp row title', () => {
    expect(slotLabel('2026-10-16T19:30:00')).toBe('Sex 16/10 19:30');
  });
});

describe('pickSlots', () => {
  it('earliest first, one professional per repeated time', () => {
    const a = { id: 'a', nome: 'Ana' };
    const b = { id: 'b', nome: 'Bia' };
    const picked = pickSlots(
      [
        {
          professional: a,
          slots: [
            { inicio: '2026-10-16T10:00:00', fim: '' },
            { inicio: '2026-10-16T11:00:00', fim: '' },
          ],
        },
        {
          professional: b,
          slots: [
            { inicio: '2026-10-16T09:30:00', fim: '' },
            { inicio: '2026-10-16T10:00:00', fim: '' },
          ],
        },
      ],
      3
    );
    expect(picked.map((p) => `${p.professional.nome} ${p.inicio}`)).toEqual([
      'Bia 2026-10-16T09:30',
      'Ana 2026-10-16T10:00',
      'Ana 2026-10-16T11:00',
    ]);
  });
});

describe('helpers', () => {
  it('prices, phones, idempotency keys', () => {
    expect(priceText({ precoCentavos: 5000, precoAPartirDe: true })).toMatch(
      /^a partir de R\$\s50,00$/
    );
    expect(phoneDigits('+55 (85) 99999-0000')).toBe('5585999990000');
    expect(phoneDigits('123')).toBeNull();
    const k = idempotencyKey(
      '5762c666-bd70-4f8f-9735-59643fb33d95',
      'scale|b|2026-10-16T19:30|s'
    );
    expect(k).toMatch(/^[\w.:-]{8,128}$/);
    expect(
      idempotencyKey(
        '5762c666-bd70-4f8f-9735-59643fb33d95',
        'scale|b|2026-10-16T19:30|s'
      )
    ).toBe(k);
  });
});

describe('client', () => {
  it('throws ScaleError with the API codigo', async () => {
    const fake = (async () =>
      new Response(
        JSON.stringify({ codigo: 'conflito', mensagem: 'ocupado' }),
        { status: 409 }
      )) as typeof fetch;
    const c = createScaleClient('k', 'https://x/v1', fake);
    await expect(
      c.book({
        professionalId: 'b',
        serviceIds: ['s'],
        inicio: '2026-10-16T19:30',
        name: 'Ana',
        phone: '5585',
        idempotencyKey: 'nordia-1234',
      })
    ).rejects.toMatchObject({ codigo: 'conflito', status: 409 });
    await expect(c.units()).rejects.toBeInstanceOf(ScaleError);
  });

  it('sends the key, the idempotency header and the minute-precision start', async () => {
    let seen: { url: string; init?: RequestInit } | null = null;
    const fake = (async (url: string, init?: RequestInit) => {
      seen = { url, init };
      return new Response(JSON.stringify({ id: '1', codigo: 'AG-1' }), {
        status: 201,
      });
    }) as unknown as typeof fetch;
    await createScaleClient('secret', 'https://x/v1/', fake).book({
      professionalId: 'b',
      serviceIds: ['s'],
      inicio: '2026-10-16T19:30:00',
      name: 'Ana',
      phone: '5585',
      idempotencyKey: 'nordia-1234',
    });
    const s = seen as unknown as { url: string; init: RequestInit };
    expect(s.url).toBe('https://x/v1/agendamentos');
    const h = s.init.headers as Record<string, string>;
    expect(h.Authorization).toBe('Bearer secret');
    expect(h['Idempotency-Key']).toBe('nordia-1234');
    expect(JSON.parse(String(s.init.body)).inicio).toBe('2026-10-16T19:30');
  });
});
