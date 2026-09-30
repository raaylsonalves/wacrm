import { describe, it, expect } from 'vitest';
import { findMatches } from './thread-search';

const msgs = [
  { id: 'a', content_text: 'Quero uma cotação do plano' },
  { id: 'b', content_text: 'Ok!' },
  { id: 'c', content_text: null, transcript: 'mande a COTACAO por favor' },
];

describe('findMatches', () => {
  it('ignores case and accents, oldest first', () => {
    expect(findMatches(msgs, 'cotacao')).toEqual(['a', 'c']);
  });

  it('searches voice-note transcripts', () => {
    expect(findMatches(msgs, 'por favor')).toEqual(['c']);
  });

  it('needs at least two characters', () => {
    expect(findMatches(msgs, 'o')).toEqual([]);
    expect(findMatches(msgs, '  ')).toEqual([]);
  });
});
