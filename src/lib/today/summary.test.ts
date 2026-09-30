import { describe, it, expect } from 'vitest';
import { dayBounds, firstName, greetingFor, pctChange } from './summary';

describe('greetingFor', () => {
  it.each([
    [5, 'morning'],
    [11, 'morning'],
    [12, 'afternoon'],
    [17, 'afternoon'],
    [18, 'evening'],
    [2, 'evening'],
  ])('%i h → %s', (h, g) => expect(greetingFor(h)).toBe(g));
});

describe('dayBounds', () => {
  it('local midnight today and the day before', () => {
    const { todayStart, yesterdayStart } = dayBounds(
      new Date(2026, 8, 30, 14, 25)
    );
    expect(todayStart).toEqual(new Date(2026, 8, 30));
    expect(yesterdayStart).toEqual(new Date(2026, 8, 29));
  });
  it('crosses a month boundary', () => {
    expect(dayBounds(new Date(2026, 9, 1, 8)).yesterdayStart).toEqual(
      new Date(2026, 8, 30)
    );
  });
});

describe('pctChange', () => {
  it('rounds the change', () => {
    expect(pctChange(12, 9)).toBe(33);
    expect(pctChange(4, 8)).toBe(-50);
    expect(pctChange(3, 3)).toBe(0);
  });
  it('no comparison against zero', () => expect(pctChange(5, 0)).toBeNull());
});

describe('firstName', () => {
  it('first word, empty when missing', () => {
    expect(firstName('Raylson Alves')).toBe('Raylson');
    expect(firstName('  Ana ')).toBe('Ana');
    expect(firstName(null)).toBe('');
  });
});
