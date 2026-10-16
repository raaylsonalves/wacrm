import { describe, expect, it } from 'vitest';
import { placeNotes } from './notes-timeline';

const m = (id: string, at: string) => ({ id, created_at: `2026-10-16T${at}:00Z` });
const n = (body: string, at: string) => ({ body, created_at: `2026-10-16T${at}:00Z` });

describe('placeNotes', () => {
  it('puts each note before the next message, the newest at the end', () => {
    const { before, after } = placeNotes(
      [m('a', '10:00'), m('b', '11:00'), m('c', '12:00')],
      [n('late', '13:00'), n('mid', '10:30'), n('mid2', '10:45'), n('first', '09:00')]
    );
    expect(before.get('a')?.map((x) => x.body)).toEqual(['first']);
    expect(before.get('b')?.map((x) => x.body)).toEqual(['mid', 'mid2']);
    expect(before.has('c')).toBe(false);
    expect(after.map((x) => x.body)).toEqual(['late']);
  });

  it('with no messages every note goes at the end', () => {
    expect(placeNotes([], [n('x', '10:00')]).after).toHaveLength(1);
  });
});
