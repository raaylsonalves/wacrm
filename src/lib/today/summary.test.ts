import { describe, it, expect } from 'vitest';
import { firstName, greetingFor } from './summary';

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

describe('firstName', () => {
  it('first word, empty when missing', () => {
    expect(firstName('Raylson Alves')).toBe('Raylson');
    expect(firstName('  Ana ')).toBe('Ana');
    expect(firstName(null)).toBe('');
  });
});
