import { describe, expect, it } from 'vitest';
import { lookFor, placeTeam, spriteFor, type RoomMemberInput } from './room';

const m = (over: Partial<RoomMemberInput>): RoomMemberInput => ({
  userId: 'u',
  name: 'Ana',
  role: 'agent',
  presence: 'online',
  waiting: 0,
  late: false,
  justWon: false,
  negotiating: false,
  ...over,
});

describe('placeTeam', () => {
  it('puts each state in its room', () => {
    const out = placeTeam([
      m({ userId: 'a', name: 'A', justWon: true, waiting: 2 }),
      m({ userId: 'b', name: 'B', negotiating: true }),
      m({ userId: 'c', name: 'C', presence: 'away' }),
      m({ userId: 'd', name: 'D', waiting: 1, late: true }),
      m({ userId: 'e', name: 'E', role: 'owner' }),
      m({ userId: 'f', name: 'F' }),
      m({ userId: 'g', name: 'G', presence: 'offline' }),
    ]);
    expect(out.map((p) => [p.name, p.room, p.pose])).toEqual([
      ['A', 'comemoracao', 'celebrate'],
      ['B', 'negociacao', 'idle'],
      ['C', 'recepcao', 'idle'],
      ['D', 'atendimento', 'phone'],
      ['E', 'gestao', 'desk'],
      ['F', 'atendimento', 'desk'],
    ]);
  });
  it('looks are stable and every look has every frame', () => {
    expect(lookFor('abc')).toBe(lookFor('abc'));
    for (const id of ['a', 'b', 'c', 'zz', 'demo-7'])
      expect(lookFor(id)).toBeGreaterThanOrEqual(1);
    expect(spriteFor(1, 'desk')).toBe('/hub/char-p1-desk.webp');
    expect(spriteFor(3, 'walk-a')).toBe('/hub/char-p3-walk-a.webp');
  });
});
