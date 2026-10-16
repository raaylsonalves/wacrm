'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import { placeTeam, type Placed, type RoomId, type RoomMemberInput } from '@/lib/dashboard/room';
import {
  ROOM_DEFS,
  assignPlaces,
  facingOf,
  findPath,
  placeTile,
  propPlacement,
  tileCenter,
  tileWidth,
  type Facing,
  type Place,
  type Pt,
  type Tile,
} from '@/lib/dashboard/room-map';

/**
 * The live room for the TV hub, v2 (specs/hub-sala-viva.md). Empty floors
 * with the furniture placed on an isometric grid (lib/dashboard/room-map),
 * everything drawn by depth so people sit behind desks and in chairs. Each
 * person gets their own seat or spot and walks there tile by tile — down
 * the stairs, across the ground, up the next stairs. The walk runs in a
 * requestAnimationFrame loop that writes styles straight to the DOM.
 */

// Stage boxes in % (left, top, width) of the 16:9 stage.
const BOX: Record<RoomId, { left: number; top: number; width: number; dot: string }> = {
  gestao: { left: 1.5, top: 2, width: 32, dot: 'bg-[#F5A99A]' },
  atendimento: { left: 33, top: 20, width: 36, dot: 'bg-[#9CC9F5]' },
  comemoracao: { left: 70, top: 3, width: 28, dot: 'bg-[#F7D774]' },
  recepcao: { left: 2, top: 51, width: 30, dot: 'bg-[#8FD9C4]' },
  negociacao: { left: 69, top: 49, width: 29, dot: 'bg-[#C9B6F2]' },
};
const ROOM_ORDER: RoomId[] = ['gestao', 'comemoracao', 'atendimento', 'negociacao', 'recepcao'];
const FLOOR_W = 640;
/** Looks that have the sitting and back-view poses (char-p<n>-sit-*.webp). */
const FULL_LOOKS = new Set([1, 2, 3, 4, 5, 6]);
/** Walking speed, in % of the stage width per second. */
const SPEED = 7;
const GROUND_Z = 900_000;

/** Floor px → stage % (both axes in % of the stage's own size). */
function toStage(room: RoomId, p: Pt): Pt {
  const b = BOX[room];
  return { x: b.left + (p.x / FLOOR_W) * b.width, y: b.top + (p.y / FLOOR_W) * b.width * (16 / 9) };
}
const roomBase = (room: RoomId) => Math.round(BOX[room].top * 1000);
const tileZ = (room: RoomId, [i, j]: Tile, layer: number) => roomBase(room) + (i + j) * 10 + layer;
/** A person on this tile: above any furniture that covers it (the sofa). */
function personZ(room: RoomId, tile: Tile): number {
  const def = ROOM_DEFS[room];
  const under = def.props.find((pr) => pr.tiles.some(([i, j]) => i === tile[0] && j === tile[1]));
  return under ? roomBase(room) + propPlacement(def, under).depth * 10 + 8 : tileZ(room, tile, 7);
}
/** A standing person's height, in stage-width % (cqw). */
const personHeight = (room: RoomId) => (tileWidth(ROOM_DEFS[room]) * 1.45 * BOX[room].width) / FLOOR_W;

interface Waypoint {
  x: number;
  y: number;
  z: number;
}

interface Walker {
  pos: Waypoint;
  path: Waypoint[];
  facing: Facing;
  step: number;
  room: RoomId;
  height: number;
}

/** Waypoints from one place to another, through stairs and ground if needed. */
function route(from: { room: RoomId; tile: Tile }, to: { room: RoomId; tile: Tile }): Waypoint[] {
  const wp = (room: RoomId, t: Tile): Waypoint => {
    const s = toStage(room, tileCenter(ROOM_DEFS[room], t));
    return { x: s.x, y: s.y, z: personZ(room, t) };
  };
  if (from.room === to.room) {
    const path = findPath(ROOM_DEFS[to.room], from.tile, to.tile) ?? [from.tile, to.tile];
    return path.slice(1).map((t) => wp(to.room, t));
  }
  const a = ROOM_DEFS[from.room];
  const b = ROOM_DEFS[to.room];
  const out = (findPath(a, from.tile, a.entrance) ?? [a.entrance]).slice(1).map((t) => wp(from.room, t));
  const ga = toStage(from.room, a.ground);
  const gb = toStage(to.room, b.ground);
  out.push({ ...ga, z: GROUND_Z }, { ...gb, z: GROUND_Z });
  out.push(...(findPath(b, b.entrance, to.tile) ?? [b.entrance, to.tile]).map((t) => wp(to.room, t)));
  return out;
}

export function LiveRoom({
  members,
  queue,
  aiReplies,
}: {
  members: RoomMemberInput[];
  /** Customers waiting with nobody assigned. */
  queue: number;
  aiReplies: number;
}) {
  const t = useTranslations('Hub.room');
  const placed = useMemo(() => placeTeam(members), [members]);

  // Seats for those who sit (working at a desk, the boss, a negotiation,
  // a coffee on the sofa); spots for the rest. Sticky between refreshes.
  const [places, setPlaces] = useState(() => new Map<string, Place | null>());
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- derived from the previous assignment, on purpose
    setPlaces((prev) =>
      assignPlaces(
        placed.map((p) => ({
          id: p.userId,
          room: p.room,
          sits: p.pose === 'desk' || p.pose === 'phone' || p.room === 'negociacao' || (p.room === 'recepcao' && p.away),
        })),
        new Map([...prev].filter((e): e is [string, Place] => e[1] !== null))
      )
    );
  }, [placed]);

  const walkers = useRef(new Map<string, Walker>());
  const els = useRef(new Map<string, { root: HTMLDivElement | null; img: HTMLImageElement | null; bubble: HTMLSpanElement | null }>());
  const visible = useMemo(() => placed.filter((p) => places.get(p.userId)), [placed, places]);
  const overflow = new Map<RoomId, number>();
  for (const p of placed) if (!places.get(p.userId)) overflow.set(p.room, (overflow.get(p.room) ?? 0) + 1);

  // New targets → new routes. First sight: appear in place, no walk.
  useEffect(() => {
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const seen = new Set<string>();
    for (const p of visible) {
      const place = places.get(p.userId)!;
      const tile = placeTile(place);
      seen.add(p.userId);
      const def = ROOM_DEFS[place.room];
      const c = tileCenter(def, tile);
      // Seated: drop onto the seat (the chair's seat sits below the tile centre).
      const s = toStage(place.room, place.kind === 'seat' ? { x: c.x, y: c.y + tileWidth(def) * 0.22 } : c);
      const target: Waypoint = { x: s.x, y: s.y, z: personZ(place.room, tile) };
      const w = walkers.current.get(p.userId);
      const height = personHeight(place.room);
      if (!w || reduce) {
        walkers.current.set(p.userId, { pos: target, path: [], facing: 'se', step: 0, room: place.room, height });
        continue;
      }
      const last = w.path.length ? w.path[w.path.length - 1] : w.pos;
      if (Math.abs(last.x - target.x) < 0.01 && Math.abs(last.y - target.y) < 0.01) continue;
      // Route from the tile they are on (or heading to) in their room.
      const fromTile = nearestTile(w.room, w.path.length ? w.path[0] : w.pos);
      w.path = route({ room: w.room, tile: fromTile }, { room: place.room, tile });
      if (w.path.length) w.path[w.path.length - 1] = target;
      else w.path = [target];
      w.room = place.room;
      w.height = height;
    }
    for (const id of walkers.current.keys()) if (!seen.has(id)) walkers.current.delete(id);
  }, [visible, places]);

  // The walk loop: move along the path, pick the frame, write the DOM.
  const placedById = useRef(new Map<string, { p: Placed; place: Place }>());
  useEffect(() => {
    placedById.current = new Map(visible.map((p) => [p.userId, { p, place: places.get(p.userId)! }]));
  }, [visible, places]);
  useEffect(() => {
    let raf = 0;
    let lastT = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - lastT) / 1000);
      lastT = now;
      for (const [id, w] of walkers.current) {
        const el = els.current.get(id);
        const info = placedById.current.get(id);
        if (!el?.root || !el.img || !info) continue;
        let moving = false;
        if (w.path.length) {
          moving = true;
          const next = w.path[0];
          const dx = next.x - w.pos.x;
          const dy = (next.y - w.pos.y) * (9 / 16); // y in stage-height %, compare in width units
          const dist = Math.hypot(dx, dy);
          const stepLen = SPEED * dt;
          if (dist <= stepLen) {
            w.pos = next;
            w.path.shift();
          } else {
            w.pos = { x: w.pos.x + (dx / dist) * stepLen, y: w.pos.y + ((next.y - w.pos.y) / dist) * stepLen, z: Math.max(w.pos.z, next.z) };
            if (dist > 0.05) w.facing = facingOf(dx, dy);
          }
          w.step += dt;
          if (!w.path.length) w.pos = { ...w.pos, z: next.z };
        }
        const look = info.p.look;
        const full = FULL_LOOKS.has(look);
        let frame: string;
        let flip = false;
        let scale = 1;
        if (moving) {
          const alt = Math.floor(w.step / 0.22) % 2 === 0 ? 'a' : 'b';
          const back = (w.facing === 'nw' || w.facing === 'ne') && full;
          frame = back ? `back-walk-${alt}` : `walk-${alt}`;
          flip = w.facing === 'sw' || w.facing === 'ne';
        } else if (info.place.kind === 'seat' && full) {
          const seat = ROOM_DEFS[info.place.room].seats[info.place.index];
          frame = seat.pose;
          flip = seat.flip;
          scale = 0.8;
        } else {
          frame = info.p.pose === 'celebrate' ? 'celebrate' : info.p.pose === 'phone' && !full ? 'phone' : 'idle';
        }
        const src = `/hub/char-p${look}-${frame}.webp`;
        if (el.img.getAttribute('src') !== src) el.img.setAttribute('src', src);
        el.img.style.height = `${w.height * scale}cqw`;
        el.img.style.transform = flip ? 'scaleX(-1)' : '';
        el.root.style.left = `${w.pos.x}%`;
        el.root.style.top = `${w.pos.y}%`;
        el.root.style.zIndex = String(Math.round(w.pos.z));
        if (el.bubble) el.bubble.style.visibility = moving ? 'hidden' : 'visible';
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="relative h-full w-full overflow-hidden rounded-[28px] bg-[#1E2A2E] [container-type:size]">
      <div className="absolute top-1/2 left-1/2 aspect-video w-full max-h-full -translate-x-1/2 -translate-y-1/2 [container-type:inline-size]" style={{ maxWidth: 'calc(100cqh * 16 / 9)' }}>
        {ROOM_ORDER.map((room) => {
          const box = BOX[room];
          const def = ROOM_DEFS[room];
          const base = roomBase(room);
          const extra = overflow.get(room);
          const label = toStage(room, def.floor.top);
          return (
            <div key={room}>
              {/* eslint-disable-next-line @next/next/no-img-element -- static art */}
              <img
                src={`/hub/floor-${room}.webp`}
                alt=""
                draggable={false}
                className="absolute select-none"
                style={{ left: `${box.left}%`, top: `${box.top}%`, width: `${box.width}%`, zIndex: base }}
              />
              {def.props.map((prop, k) => {
                const pl = propPlacement(def, prop);
                const at = toStage(room, pl.foot);
                return (
                  // eslint-disable-next-line @next/next/no-img-element -- static art
                  <img
                    key={k}
                    src={`/hub/item-${prop.sprite}.webp`}
                    alt=""
                    draggable={false}
                    className="absolute select-none"
                    style={{
                      left: `${at.x}%`,
                      top: `${at.y}%`,
                      width: `${(pl.width / FLOOR_W) * box.width}%`,
                      zIndex: base + pl.depth * 10 + 5,
                      transform: `translate(-50%, -100%)${prop.flip ? ' scaleX(-1)' : ''}`,
                    }}
                  />
                );
              })}
              {def.seats.map((seat, k) =>
                seat.chair ? (
                  // eslint-disable-next-line @next/next/no-img-element -- static art
                  <img
                    key={`c${k}`}
                    src={`/hub/item-${seat.chair}.webp`}
                    alt=""
                    draggable={false}
                    className="absolute select-none"
                    style={(() => {
                      const c = toStage(room, tileCenter(def, seat.tile));
                      const w = ((tileWidth(def) * 0.8) / FLOOR_W) * box.width;
                      return {
                        left: `${c.x}%`,
                        top: `${c.y + w * 0.35}%`,
                        width: `${w}%`,
                        zIndex: tileZ(room, seat.tile, 3),
                        transform: `translate(-50%, -100%)${seat.chairFlip ? ' scaleX(-1)' : ''}`,
                      };
                    })()}
                  />
                ) : null
              )}
              <span
                className="absolute flex -translate-x-1/2 -translate-y-full items-center gap-[0.5cqw] text-[1.4cqw] font-extrabold whitespace-nowrap text-white drop-shadow"
                style={{ left: `${label.x}%`, top: `${label.y - 1}%`, zIndex: GROUND_Z + 10 }}
              >
                <span className={cn('size-[1cqw] rounded-full', box.dot)} />
                {t(`name.${room}`)}
                {extra ? <span className="rounded-full bg-white px-[0.5cqw] text-[0.9cqw] text-[#1E2A2E]">+{extra}</span> : null}
              </span>
            </div>
          );
        })}

        {/* Reception: the queue and the AI, over the counter. */}
        {(queue > 0 || aiReplies > 0) &&
          (() => {
            const def = ROOM_DEFS.recepcao;
            // Just above the reception counter.
            const counter = def.props.find((pr) => pr.sprite === 'counter')!;
            const at = toStage('recepcao', propPlacement(def, counter).foot);
            return (
              <span className="absolute flex -translate-x-1/2 flex-col items-center gap-[0.3cqw]" style={{ left: `${at.x}%`, top: `${at.y - 11}%`, zIndex: GROUND_Z + 5 }}>
                {queue > 0 && (
                  <span className="rounded-full bg-[#F06A5B] px-[0.8cqw] py-[0.2cqw] text-[0.95cqw] font-extrabold whitespace-nowrap text-white shadow">{t('queue', { n: queue })}</span>
                )}
                {aiReplies > 0 && (
                  <span className="rounded-full bg-white px-[0.8cqw] py-[0.2cqw] text-[0.95cqw] font-bold whitespace-nowrap text-[#1E2A2E] shadow">🤖 {t('ai', { n: aiReplies })}</span>
                )}
              </span>
            );
          })()}

        {visible.map((p) => (
          <div
            key={p.userId}
            ref={(root) => {
              const cur = els.current.get(p.userId) ?? { root: null, img: null, bubble: null };
              els.current.set(p.userId, { ...cur, root });
            }}
            className="absolute flex -translate-x-1/2 -translate-y-full flex-col items-center"
          >
            <span
              ref={(bubble) => {
                const cur = els.current.get(p.userId) ?? { root: null, img: null, bubble: null };
                els.current.set(p.userId, { ...cur, bubble });
              }}
              className="mb-[0.2cqw] h-[1.6cqw]"
            >
              <Bubble p={p} />
            </span>
            {/* eslint-disable-next-line @next/next/no-img-element -- sprite, frame set by the walk loop */}
            <img
              ref={(img) => {
                const cur = els.current.get(p.userId) ?? { root: null, img: null, bubble: null };
                els.current.set(p.userId, { ...cur, img });
              }}
              alt=""
              draggable={false}
              className={cn('w-auto select-none drop-shadow-[0_0.3cqw_0.2cqw_rgba(0,0,0,0.25)]', p.away && 'opacity-80')}
            />
            <span className={cn('mt-[0.2cqw] max-w-[9cqw] truncate rounded-full px-[0.6cqw] text-[0.85cqw] font-bold shadow', p.late ? 'bg-[#F06A5B] text-white' : 'bg-white text-[#1E2A2E]')}>
              {p.name.split(' ')[0]}
              <span className="sr-only"> · {t(`pose.${p.away ? 'away' : p.pose}`)}</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** The tile under a stage point, in that room. */
function nearestTile(room: RoomId, p: Pt): Tile {
  const def = ROOM_DEFS[room];
  let best: Tile = def.entrance;
  let bestD = Infinity;
  for (let i = 0; i < def.n; i++)
    for (let j = 0; j < def.n; j++) {
      const c = toStage(room, tileCenter(def, [i, j]));
      const d = Math.hypot(c.x - p.x, c.y - p.y);
      if (d < bestD) {
        bestD = d;
        best = [i, j];
      }
    }
  return best;
}

function Bubble({ p }: { p: Placed }) {
  if (p.pose === 'celebrate') return <span className="animate-bounce text-[1.4cqw]">🎉</span>;
  if (p.away) return <span className="rounded-full bg-white/90 px-[0.5cqw] text-[1cqw]">☕</span>;
  if (p.waiting > 0)
    return (
      <span className={cn('rounded-full px-[0.6cqw] py-[0.1cqw] text-[0.9cqw] font-extrabold text-white shadow', p.late ? 'animate-pulse bg-[#F06A5B]' : 'bg-[#25D366]')}>
        💬 {p.waiting}
      </span>
    );
  if (p.pose === 'desk')
    return (
      <span className="flex gap-[0.2cqw] rounded-full bg-white/90 px-[0.5cqw] py-[0.35cqw]">
        {[0, 1, 2].map((d) => (
          <span key={d} className="size-[0.35cqw] animate-bounce rounded-full bg-[#1E2A2E]" style={{ animationDelay: `${d * 150}ms` }} />
        ))}
      </span>
    );
  return null;
}
