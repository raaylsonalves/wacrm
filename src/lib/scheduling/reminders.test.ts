import { describe, expect, it } from 'vitest';
import { localNow, reminderDue, reminderText } from './reminders';

describe('booking reminders', () => {
  it("reads the shop's wall clock", () => {
    // 17:30 UTC = 14:30 in Fortaleza (UTC-3, no DST).
    expect(
      localNow('America/Fortaleza', new Date('2026-10-21T17:30:00Z'))
    ).toBe('2026-10-21T14:30:00');
  });

  it('is due inside the window before the start, never after', () => {
    const start = '2026-10-21T13:30:00';
    expect(reminderDue(start, '2026-10-21T12:30:00', 60)).toBe(true);
    expect(reminderDue(start, '2026-10-21T12:20:00', 60)).toBe(false);
    expect(reminderDue(start, '2026-10-21T13:30:00', 60)).toBe(false);
  });

  it('fills the placeholders', () => {
    expect(
      reminderText(
        'Oi {nome}! Seu horário é hoje ({data}) às {hora} com {barbeiro}. Código {codigo}.',
        {
          name: 'Enzo Castro',
          startsLocal: '2026-10-21T13:30:00',
          professional: 'Souzza',
          code: 'AG-1',
        }
      )
    ).toBe(
      'Oi Enzo! Seu horário é hoje (21/10) às 13h30 com Souzza. Código AG-1.'
    );
    expect(
      reminderText('Oi {nome}! Às {hora}.', {
        name: null,
        startsLocal: '2026-10-21T14:00:00',
        professional: null,
        code: null,
      })
    ).toBe('Oi! Às 14h.');
  });
});
