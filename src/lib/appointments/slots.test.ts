import { describe, expect, it } from 'vitest';
import {
  formatSlotLabel,
  generateFreeSlots,
  parseSlotReplyId,
  renderReminder,
  slotReplyId,
  zonedToUtc,
} from './slots';

const SP = 'America/Sao_Paulo'; // UTC-3, no DST since 2019

const settings = {
  timezone: SP,
  work_days: [1, 2, 3, 4, 5],
  day_start: '09:00',
  day_end: '11:00',
  slot_minutes: 30,
};

describe('zonedToUtc', () => {
  it('converts São Paulo wall-clock to UTC', () => {
    expect(zonedToUtc(2026, 9, 23, 9, 0, SP).toISOString()).toBe(
      '2026-09-23T12:00:00.000Z',
    );
  });

  it('handles a DST zone on both sides of the change', () => {
    const ny = 'America/New_York';
    expect(zonedToUtc(2026, 1, 15, 9, 0, ny).toISOString()).toBe('2026-01-15T14:00:00.000Z');
    expect(zonedToUtc(2026, 7, 15, 9, 0, ny).toISOString()).toBe('2026-07-15T13:00:00.000Z');
  });
});

describe('generateFreeSlots', () => {
  // Wednesday 2026-09-23 08:00 in São Paulo.
  const now = new Date('2026-09-23T11:00:00Z');

  it('lists slots inside business hours, skipping the past', () => {
    const slots = generateFreeSlots({ now, settings, busy: [], daysAhead: 0, limit: 10 });
    expect(slots.map((s) => s.toISOString())).toEqual([
      '2026-09-23T12:00:00.000Z',
      '2026-09-23T12:30:00.000Z',
      '2026-09-23T13:00:00.000Z',
      '2026-09-23T13:30:00.000Z',
    ]);
  });

  it('skips slots that overlap a busy range', () => {
    const busy = [
      { start: new Date('2026-09-23T12:15:00Z'), end: new Date('2026-09-23T12:45:00Z') },
    ];
    const slots = generateFreeSlots({ now, settings, busy, daysAhead: 0, limit: 10 });
    expect(slots.map((s) => s.toISOString())).toEqual([
      '2026-09-23T13:00:00.000Z',
      '2026-09-23T13:30:00.000Z',
    ]);
  });

  it('skips non-working days and respects the limit', () => {
    // Friday 17:00 local — nothing left today, weekend skipped, Monday next.
    const friday = new Date('2026-09-25T20:00:00Z');
    const slots = generateFreeSlots({ now: friday, settings, busy: [], daysAhead: 5, limit: 2 });
    expect(slots.map((s) => s.toISOString())).toEqual([
      '2026-09-28T12:00:00.000Z',
      '2026-09-28T12:30:00.000Z',
    ]);
  });

  it('fits a longer duration only where it ends before closing', () => {
    const slots = generateFreeSlots({
      now,
      settings,
      busy: [],
      daysAhead: 0,
      limit: 10,
      durationMinutes: 90,
    });
    expect(slots.map((s) => s.toISOString())).toEqual([
      '2026-09-23T12:00:00.000Z',
      '2026-09-23T12:30:00.000Z',
    ]);
  });
});

describe('slot reply ids', () => {
  it('round-trips a slot start', () => {
    const start = new Date('2026-09-23T12:00:00Z');
    expect(parseSlotReplyId(slotReplyId(start))?.toISOString()).toBe(start.toISOString());
  });

  it('rejects ids that are not slots', () => {
    expect(parseSlotReplyId('btn_1')).toBeNull();
    expect(parseSlotReplyId('slot:not-a-date')).toBeNull();
  });
});

describe('formatting', () => {
  it('keeps list-row labels within the 24-char Meta limit', () => {
    const label = formatSlotLabel(new Date('2026-09-23T12:00:00Z'), SP);
    expect(label).toMatch(/23\/09 09:00$/);
    expect(label.length).toBeLessThanOrEqual(24);
  });

  it('fills reminder placeholders', () => {
    expect(
      renderReminder('Oi {{nome}}, {{data}} às {{hora}}', {
        nome: 'Ana',
        data: '23/09',
        hora: '09:00',
      }),
    ).toBe('Oi Ana, 23/09 às 09:00');
  });
});
