import { describe, expect, it } from 'vitest';
import { serverSearchTerm } from './server-search';

describe('serverSearchTerm', () => {
  it('skips queries too short to be worth a round trip', () => {
    expect(serverSearchTerm('')).toBeNull();
    expect(serverSearchTerm(' a ')).toBeNull();
  });

  it('keeps ordinary names and phone numbers', () => {
    expect(serverSearchTerm('  Maria  Silva ')).toBe('Maria Silva');
    expect(serverSearchTerm('+55 85 9999-0000')).toBe('+55 85 9999-0000');
  });

  it('drops characters that would break or widen a PostgREST or-filter', () => {
    expect(serverSearchTerm('a,b)c(d')).toBe('a b c d');
    expect(serverSearchTerm('50%_off*')).toBe('50 off');
    expect(serverSearchTerm('"x\\y\'')).toBe('x y');
  });

  it('is null when only stripped characters remain', () => {
    expect(serverSearchTerm('%%,,')).toBeNull();
  });
});
