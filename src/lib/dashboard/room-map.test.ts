import { describe, expect, it } from 'vitest';
import {
  ROOM_DEFS,
  assignPlaces,
  blockedTiles,
  facingOf,
  findPath,
  gridToPx,
  placeTile,
  type Place,
} from './room-map';
import { ROOMS } from './room';

describe('room maps', () => {
  it('every seat, spot and entrance is on the floor and spots are not blocked', () => {
    for (const room of ROOMS) {
      const def = ROOM_DEFS[room];
      const blocked = blockedTiles(def);
      const inside = ([i, j]: [number, number]) =>
        i >= 0 && j >= 0 && i < def.n && j < def.n;
      for (const s of def.seats) expect(inside(s.tile)).toBe(true);
      for (const s of def.spots) {
        expect(inside(s)).toBe(true);
        expect(blocked.has(`${s[0]},${s[1]}`)).toBe(false);
      }
      expect(blocked.has(`${def.entrance[0]},${def.entrance[1]}`)).toBe(false);
    }
  });

  it('everyone can walk from the stairs to every seat and spot', () => {
    for (const room of ROOMS) {
      const def = ROOM_DEFS[room];
      for (const t of [...def.seats.map((s) => s.tile), ...def.spots]) {
        expect(findPath(def, def.entrance, t), `${room} → ${t}`).not.toBeNull();
      }
    }
  });

  it('paths go around desks', () => {
    const def = ROOM_DEFS.atendimento;
    const path = findPath(def, [1, 2], [1, 4])!;
    const blocked = blockedTiles(def);
    expect(path.slice(1, -1).every(([i, j]) => !blocked.has(`${i},${j}`))).toBe(
      true
    );
    expect(path.length).toBeGreaterThan(3);
  });

  it('grid corners land on the floor corners', () => {
    const def = ROOM_DEFS.gestao;
    expect(gridToPx(def, 0, 0)).toEqual(def.floor.top);
    expect(gridToPx(def, def.n, 0)).toEqual(def.floor.right);
  });

  it('facing follows the screen direction', () => {
    expect(facingOf(1, 1)).toBe('se');
    expect(facingOf(-1, 1)).toBe('sw');
    expect(facingOf(-1, -1)).toBe('nw');
    expect(facingOf(1, -1)).toBe('ne');
  });
});

describe('assignPlaces', () => {
  it('never shares a place and keeps last time’s', () => {
    const people = ['a', 'b', 'c'].map((id) => ({
      id,
      room: 'atendimento' as const,
      sits: true,
    }));
    const first = assignPlaces(people, new Map());
    const tiles = [...first.values()].map((p) => placeTile(p!).join());
    expect(new Set(tiles).size).toBe(3);
    const prev = new Map(
      [...first].filter(([id]) => id !== 'a') as [string, Place][]
    );
    const second = assignPlaces([...people].reverse(), prev);
    expect(second.get('b')).toEqual(first.get('b'));
    expect(second.get('c')).toEqual(first.get('c'));
  });

  it('overflows to spots, then to null', () => {
    const people = Array.from({ length: 6 }, (_, k) => ({
      id: `p${k}`,
      room: 'gestao' as const,
      sits: true,
    }));
    const out = assignPlaces(people, new Map());
    expect(out.get('p0')).toMatchObject({ kind: 'seat' });
    expect(out.get('p1')).toMatchObject({ kind: 'spot' });
    expect(out.get('p5')).toBeNull();
  });
});
