/**
 * The live room v2 (specs/hub-sala-viva.md): each floor is an isometric
 * grid of N×N tiles. Furniture sits on tiles (and blocks them), people
 * sit on seats or stand on spots, and walk tile by tile — down the
 * stairs, across the ground, up the next stairs. Pure, so it is tested.
 *
 * Tile (i, j): i runs along the floor's top→right edge (screen
 * south-east), j along top→left (screen south-west). (0,0) is the back
 * corner, (N,N) the front one.
 */
import type { RoomId } from './room';

export type Pt = { x: number; y: number };
export type Tile = [number, number];

/** Floor image calibration, in px of the 640-wide floor image. */
interface Floor {
  top: Pt;
  left: Pt;
  right: Pt;
  height: number;
}

export interface Prop {
  sprite: string;
  /** Tiles it covers (and blocks). */
  tiles: Tile[];
  /** Sprite width as a share of the footprint's screen width. */
  fit: number;
  flip?: boolean;
  /** Fine nudge of the foot point, in tile widths. */
  dx?: number;
  dy?: number;
}

export type SeatPose = 'sit-type' | 'sit-relax';

export interface Seat {
  tile: Tile;
  pose: SeatPose;
  /** Mirror the sitter: faces south-west instead of south-east. */
  flip: boolean;
  /** The chair drawn under the sitter (drawn just behind them). */
  chair?: string;
  chairFlip?: boolean;
  /** How far below the tile centre the sitter sits, in tile widths (default 0.22). */
  drop?: number;
}

export interface RoomDef {
  id: RoomId;
  n: number;
  floor: Floor;
  props: Prop[];
  seats: Seat[];
  /** Standing spots, in order of preference. */
  spots: Tile[];
  /** Floor tile at the head of the stairs, and the stairs' foot on the ground. */
  entrance: Tile;
  ground: Pt;
}

const N = 8;

export const ROOM_DEFS: Record<RoomId, RoomDef> = {
  atendimento: {
    id: 'atendimento',
    n: N,
    floor: {
      top: { x: 296, y: 4 },
      left: { x: 4, y: 172 },
      right: { x: 635, y: 195 },
      height: 442,
    },
    props: [
      { sprite: 'water', tiles: [[0, 0]], fit: 0.55 },
      { sprite: 'plant-small', tiles: [[0, 2]], fit: 0.6 },
      {
        sprite: 'bookshelf',
        tiles: [
          [0, 5],
          [0, 6],
        ],
        fit: 0.85,
        flip: true,
      },
      { sprite: 'plant-tall', tiles: [[7, 0]], fit: 0.85 },
      // The desk art runs along j with the keyboard on its north-west side;
      // mirrored it runs along i with the keyboard on the j-1 side, where
      // people sit facing south-west, the desk in front of them.
      ...(
        [
          [1, 3],
          [4, 3],
          [1, 6],
          [4, 6],
        ] as Tile[]
      ).map(([i, j]) => ({
        sprite: 'desk',
        tiles: [
          [i, j],
          [i + 1, j],
        ] as Tile[],
        fit: 0.95,
        flip: true,
      })),
    ],
    seats: (
      [
        [1, 2],
        [2, 2],
        [4, 2],
        [5, 2],
        [1, 5],
        [2, 5],
        [4, 5],
        [5, 5],
      ] as Tile[]
    ).map((tile) => ({
      tile,
      pose: 'sit-type' as const,
      flip: true,
      chair: 'chair-b',
      chairFlip: true,
    })),
    spots: [
      [3, 4],
      [6, 4],
      [3, 1],
      [6, 1],
      [7, 7],
      [3, 7],
    ],
    entrance: [7, 5],
    ground: { x: 515, y: 432 },
  },
  gestao: {
    id: 'gestao',
    n: N,
    floor: {
      top: { x: 352, y: 5 },
      left: { x: 5, y: 197 },
      right: { x: 634, y: 175 },
      height: 478,
    },
    props: [
      { sprite: 'plant-tall', tiles: [[0, 0]], fit: 0.85 },
      {
        sprite: 'screen',
        tiles: [
          [2, 0],
          [3, 0],
          [4, 0],
        ],
        fit: 0.85,
      },
      {
        sprite: 'bookshelf',
        tiles: [
          [0, 6],
          [0, 7],
        ],
        fit: 0.85,
        flip: true,
      },
      // Art orientation: desks and sofas run along j; armchair-a faces +i
      // (south-east), armchair-b faces +j (south-west).
      {
        sprite: 'boss-desk',
        tiles: [
          [3, 3],
          [3, 4],
        ],
        fit: 1.05,
      },
      { sprite: 'armchair-a', tiles: [[5, 3]], fit: 0.7 },
      { sprite: 'coffee-table', tiles: [[6, 3]], fit: 0.65 },
      { sprite: 'armchair-b', tiles: [[6, 2]], fit: 0.7 },
      { sprite: 'plant-small', tiles: [[7, 0]], fit: 0.6 },
    ],
    seats: [
      { tile: [2, 3], pose: 'sit-type', flip: false, chair: 'boss-chair' },
    ],
    spots: [
      [4, 6],
      [2, 6],
      [5, 4],
      [1, 2],
    ],
    entrance: [7, 5],
    ground: { x: 488, y: 466 },
  },
  recepcao: {
    id: 'recepcao',
    n: N,
    floor: {
      top: { x: 348, y: 5 },
      left: { x: 5, y: 194 },
      right: { x: 634, y: 172 },
      height: 464,
    },
    props: [
      { sprite: 'plant-tall', tiles: [[0, 0]], fit: 0.85 },
      {
        sprite: 'sofa',
        tiles: [
          [2, 1],
          [2, 2],
        ],
        fit: 1.0,
      },
      { sprite: 'coffee-table', tiles: [[4, 2]], fit: 0.65 },
      {
        sprite: 'counter',
        tiles: [
          [4, 5],
          [5, 5],
          [5, 6],
        ],
        fit: 1.0,
      },
      { sprite: 'plant-small', tiles: [[0, 7]], fit: 0.6 },
    ],
    // The sofa is a prop; its two places are seats without a chair.
    seats: [
      { tile: [2, 1], pose: 'sit-relax', flip: false, drop: 0.5 },
      { tile: [2, 2], pose: 'sit-relax', flip: false, drop: 0.5 },
    ],
    spots: [
      [4, 4],
      [6, 2],
      [3, 6],
      [6, 3],
    ],
    entrance: [7, 5],
    ground: { x: 502, y: 452 },
  },
  negociacao: {
    id: 'negociacao',
    n: N,
    floor: {
      top: { x: 333, y: 5 },
      left: { x: 5, y: 183 },
      right: { x: 634, y: 177 },
      height: 475,
    },
    props: [
      { sprite: 'plant-tall', tiles: [[0, 7]], fit: 0.85 },
      {
        sprite: 'meeting-table',
        tiles: [
          [3, 3],
          [3, 4],
          [4, 3],
          [4, 4],
        ],
        fit: 0.9,
      },
      { sprite: 'plant-small', tiles: [[7, 0]], fit: 0.6 },
    ],
    seats: [
      {
        tile: [2, 4],
        pose: 'sit-relax',
        flip: false,
        chair: 'armchair-a',
        drop: 0.5,
      },
      {
        tile: [4, 2],
        pose: 'sit-relax',
        flip: true,
        chair: 'armchair-b',
        drop: 0.5,
      },
      {
        tile: [2, 3],
        pose: 'sit-relax',
        flip: false,
        chair: 'armchair-a',
        drop: 0.5,
      },
    ],
    spots: [
      [5, 5],
      [6, 3],
      [3, 6],
    ],
    entrance: [6, 7],
    ground: { x: 150, y: 462 },
  },
  comemoracao: {
    id: 'comemoracao',
    n: N,
    floor: {
      top: { x: 318, y: 6 },
      left: { x: 6, y: 186 },
      right: { x: 633, y: 192 },
      height: 491,
    },
    props: [
      { sprite: 'plant-tall', tiles: [[0, 0]], fit: 0.85 },
      { sprite: 'bell', tiles: [[2, 2]], fit: 0.55 },
      {
        sprite: 'trophy-shelf',
        tiles: [
          [0, 4],
          [0, 5],
        ],
        fit: 0.95,
        flip: true,
      },
      { sprite: 'plant-small', tiles: [[7, 1]], fit: 0.6 },
    ],
    seats: [],
    spots: [
      [3, 3],
      [4, 4],
      [2, 4],
      [4, 2],
      [5, 5],
      [3, 6],
    ],
    entrance: [5, 7],
    ground: { x: 145, y: 478 },
  },
};

// ---- geometry ---------------------------------------------------------

/** A grid point (fractional tiles) → px on the floor image. */
export function gridToPx(room: RoomDef, i: number, j: number): Pt {
  const { top, left, right } = room.floor;
  const u = i / room.n;
  const v = j / room.n;
  return {
    x: top.x + u * (right.x - top.x) + v * (left.x - top.x),
    y: top.y + u * (right.y - top.y) + v * (left.y - top.y),
  };
}

/** Centre of a tile, in floor px. */
export function tileCenter(room: RoomDef, [i, j]: Tile): Pt {
  return gridToPx(room, i + 0.5, j + 0.5);
}

/** On-screen width of one tile, in floor px. */
export function tileWidth(room: RoomDef): number {
  const a = gridToPx(room, 0, 1);
  const b = gridToPx(room, 1, 0);
  return Math.abs(b.x - a.x);
}

/** Where a prop's sprite stands: bottom-centre on its footprint, and its width. */
export function propPlacement(
  room: RoomDef,
  prop: Prop
): { foot: Pt; width: number; depth: number } {
  const is = prop.tiles.map((t) => t[0]);
  const js = prop.tiles.map((t) => t[1]);
  const i0 = Math.min(...is),
    i1 = Math.max(...is) + 1;
  const j0 = Math.min(...js),
    j1 = Math.max(...js) + 1;
  const corners = [
    gridToPx(room, i0, j0),
    gridToPx(room, i1, j0),
    gridToPx(room, i0, j1),
    gridToPx(room, i1, j1),
  ];
  const xs = corners.map((c) => c.x);
  const tw = tileWidth(room);
  const centre = gridToPx(room, (i0 + i1) / 2, (j0 + j1) / 2);
  const front = gridToPx(room, i1, j1);
  return {
    foot: {
      x: centre.x + (prop.dx ?? 0) * tw,
      y: front.y - tw * 0.12 + (prop.dy ?? 0) * tw,
    },
    width: (Math.max(...xs) - Math.min(...xs)) * prop.fit,
    depth: i1 - 1 + (j1 - 1),
  };
}

// ---- walking ----------------------------------------------------------

const key = ([i, j]: Tile) => `${i},${j}`;

export function blockedTiles(room: RoomDef): Set<string> {
  const s = new Set<string>();
  for (const p of room.props) for (const t of p.tiles) s.add(key(t));
  return s;
}

/**
 * Shortest walk between two tiles on one floor (8 directions, no corner
 * cutting past furniture). Start and goal may be blocked themselves (a
 * seat on a chair tile); the tiles between may not. Null if unreachable.
 */
export function findPath(room: RoomDef, from: Tile, to: Tile): Tile[] | null {
  const blocked = blockedTiles(room);
  const n = room.n;
  const goal = key(to);
  const free = (i: number, j: number) =>
    i >= 0 &&
    j >= 0 &&
    i < n &&
    j < n &&
    (!blocked.has(`${i},${j}`) || `${i},${j}` === goal);
  const prev = new Map<string, string | null>([[key(from), null]]);
  const queue: Tile[] = [from];
  while (queue.length) {
    const cur = queue.shift()!;
    if (key(cur) === goal) {
      const path: Tile[] = [];
      let k: string | null = goal;
      while (k) {
        const [a, b] = k.split(',').map(Number);
        path.unshift([a, b]);
        k = prev.get(k) ?? null;
      }
      return path;
    }
    for (const [di, dj] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
      [1, 1],
      [-1, -1],
      [1, -1],
      [-1, 1],
    ]) {
      const ni = cur[0] + di;
      const nj = cur[1] + dj;
      if (!free(ni, nj) || prev.has(`${ni},${nj}`)) continue;
      // Diagonal only when both sides are open (no squeezing past a desk).
      if (
        di &&
        dj &&
        (!free(cur[0] + di, cur[1]) || !free(cur[0], cur[1] + dj))
      )
        continue;
      prev.set(`${ni},${nj}`, key(cur));
      queue.push([ni, nj]);
    }
  }
  return null;
}

export type Facing = 'se' | 'sw' | 'ne' | 'nw';

/** Which way a step goes on screen. Front sprites face SE, back ones NW. */
export function facingOf(dx: number, dy: number): Facing {
  if (dy >= 0) return dx >= 0 ? 'se' : 'sw';
  return dx >= 0 ? 'ne' : 'nw';
}

// ---- who sits where ---------------------------------------------------

export type Place =
  | { room: RoomId; kind: 'seat'; index: number }
  | { room: RoomId; kind: 'spot'; index: number };

/**
 * Gives each person a free place in their room: seats first for those
 * who sit, then standing spots. Keeps last time's place when it is still
 * in the same room, so nobody shuffles on every refresh. Two people never
 * share a place; overflow gets null (shown as "+n").
 */
export function assignPlaces(
  people: { id: string; room: RoomId; sits: boolean }[],
  previous: Map<string, Place>
): Map<string, Place | null> {
  const out = new Map<string, Place | null>();
  const taken = new Set<string>();
  const tag = (p: Place) => `${p.room}:${p.kind}:${p.index}`;
  // Keep the places people already hold.
  for (const p of people) {
    const was = previous.get(p.id);
    if (
      was &&
      was.room === p.room &&
      (was.kind === 'seat') === p.sits &&
      !taken.has(tag(was))
    ) {
      out.set(p.id, was);
      taken.add(tag(was));
    }
  }
  for (const p of people) {
    if (out.has(p.id)) continue;
    const def = ROOM_DEFS[p.room];
    const options: Place[] = [
      ...(p.sits
        ? def.seats.map((_, index) => ({
            room: p.room,
            kind: 'seat' as const,
            index,
          }))
        : []),
      ...def.spots.map((_, index) => ({
        room: p.room,
        kind: 'spot' as const,
        index,
      })),
    ];
    const free = options.find((o) => !taken.has(tag(o))) ?? null;
    if (free) taken.add(tag(free));
    out.set(p.id, free);
  }
  return out;
}

export function placeTile(place: Place): Tile {
  const def = ROOM_DEFS[place.room];
  return place.kind === 'seat'
    ? def.seats[place.index].tile
    : def.spots[place.index];
}
