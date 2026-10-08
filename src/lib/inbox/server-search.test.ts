import { describe, expect, it } from 'vitest';
import { serverSearchTerm, snippetAround } from './server-search';

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

describe('snippetAround', () => {
  it('centres on the match, case-insensitively, keeping its casing', () => {
    expect(
      snippetAround('Olá, quero o Orçamento amanhã', 'orçamento', 5)
    ).toEqual({ before: '…ro o ', match: 'Orçamento', after: ' aman…' });
  });

  it('does not add ellipses when nothing was cut', () => {
    expect(snippetAround('preço?', 'preço', 10)).toEqual({
      before: '',
      match: 'preço',
      after: '?',
    });
  });

  it('collapses line breaks', () => {
    expect(snippetAround('a\n\nb pix', 'pix').before).toBe('a b ');
  });

  it('matches across accents and keeps the original text', () => {
    expect(snippetAround('Seu orçamento chegou', 'orcamento', 4)).toEqual({
      before: 'Seu ',
      match: 'orçamento',
      after: ' che…',
    });
  });

  it('falls back to the start of the text when the term is not found', () => {
    expect(snippetAround('abcdefghij', 'zz', 2)).toEqual({
      before: 'abcd…',
      match: '',
      after: '',
    });
  });
});
