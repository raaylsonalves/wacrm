'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import { placeTeam, spriteFor, type Frame, type Placed, type RoomId, type RoomMemberInput } from '@/lib/dashboard/room';

/**
 * The live room for the TV hub (specs/painel-gestor.md phase 5). Five
 * isometric floors (generated art in public/hub) on a 16:9 stage; each
 * person stands where their state puts them (lib/dashboard/room) and
 * walks there when it changes. People live in one layer over the floors,
 * in stage %, so a move between rooms is a CSS transition with the walk
 * frames playing. Sized in container units, so it scales with any screen.
 */

// Stage boxes in % (left, top, width) — the layout of the approved
// reference scene. `ratio` is the floor image's height / width.
const BOX: Record<RoomId, { left: number; top: number; width: number; ratio: number; dot: string }> = {
  gestao: { left: 1.5, top: 3, width: 33, ratio: 488 / 640, dot: 'bg-[#F5A99A]' },
  atendimento: { left: 31, top: 22, width: 38, ratio: 456 / 640, dot: 'bg-[#9CC9F5]' },
  comemoracao: { left: 70, top: 4, width: 28, ratio: 559 / 640, dot: 'bg-[#F7D774]' },
  recepcao: { left: 2, top: 52, width: 31, ratio: 472 / 640, dot: 'bg-[#8FD9C4]' },
  negociacao: { left: 69, top: 50, width: 29, ratio: 527 / 640, dot: 'bg-[#C9B6F2]' },
};

// Where people stand inside each floor image, in % of that image (feet).
const SLOTS: Record<RoomId, [number, number][]> = {
  gestao: [[36, 66], [56, 72], [22, 56]],
  atendimento: [[30, 62], [50, 46], [50, 80], [70, 64], [18, 44], [36, 34], [64, 34], [82, 50]],
  comemoracao: [[42, 60], [58, 66], [28, 66], [52, 50]],
  recepcao: [[46, 60], [30, 68], [60, 70], [22, 52]],
  negociacao: [[44, 58], [62, 64], [30, 66]],
};

const ORDER: RoomId[] = ['gestao', 'comemoracao', 'atendimento', 'recepcao', 'negociacao'];
const WALK_MS = 2600;

/** A floor-image point → stage %, for the people layer. */
function toStage(room: RoomId, [x, y]: [number, number]): { left: number; top: number } {
  const b = BOX[room];
  return { left: b.left + (x / 100) * b.width, top: b.top + (y / 100) * b.width * b.ratio * (16 / 9) };
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
  const placed = placeTeam(members);
  const byRoom = new Map<RoomId, Placed[]>();
  for (const p of placed) byRoom.set(p.room, [...(byRoom.get(p.room) ?? []), p]);

  const people: { p: Placed; pos: { left: number; top: number } }[] = [];
  const overflow: { room: RoomId; n: number }[] = [];
  for (const room of ORDER) {
    const list = byRoom.get(room) ?? [];
    list.slice(0, SLOTS[room].length).forEach((p, i) => people.push({ p, pos: toStage(room, SLOTS[room][i]) }));
    if (list.length > SLOTS[room].length) overflow.push({ room, n: list.length - SLOTS[room].length });
  }
  // Stable DOM order (moving nodes would cancel the walk transition);
  // depth comes from z-index: nearer people (lower on the stage) on top.
  people.sort((a, b) => a.p.userId.localeCompare(b.p.userId));

  return (
    <div className="relative h-full w-full overflow-hidden rounded-[28px] bg-[#1E2A2E] [container-type:size]">
      <div className="absolute top-1/2 left-1/2 aspect-video w-full max-h-full -translate-x-1/2 -translate-y-1/2 [container-type:inline-size]" style={{ maxWidth: 'calc(100cqh * 16 / 9)' }}>
        {ORDER.map((room) => {
          const box = BOX[room];
          const extra = overflow.find((o) => o.room === room);
          return (
            <div key={room} className="absolute" style={{ left: `${box.left}%`, top: `${box.top}%`, width: `${box.width}%` }}>
              {/* eslint-disable-next-line @next/next/no-img-element -- static art, sized by the stage */}
              <img src={`/hub/room-${room}.webp`} alt="" className="block w-full select-none" draggable={false} />
              <span className="absolute -top-[0.4cqw] left-[4%] flex items-center gap-[0.5cqw] text-[1.5cqw] font-extrabold text-white drop-shadow">
                <span className={cn('size-[1.1cqw] rounded-full', box.dot)} />
                {t(`name.${room}`)}
              </span>

              {room === 'recepcao' && (queue > 0 || aiReplies > 0) && (
                <span className="absolute top-[18%] left-[52%] flex flex-col items-start gap-[0.3cqw]">
                  {queue > 0 && (
                    <span className="rounded-full bg-[#F06A5B] px-[0.8cqw] py-[0.2cqw] text-[0.95cqw] font-extrabold text-white shadow">
                      {t('queue', { n: queue })}
                    </span>
                  )}
                  {aiReplies > 0 && (
                    <span className="rounded-full bg-white px-[0.8cqw] py-[0.2cqw] text-[0.95cqw] font-bold text-[#1E2A2E] shadow">
                      🤖 {t('ai', { n: aiReplies })}
                    </span>
                  )}
                </span>
              )}

              {extra && (
                <span className="absolute right-[6%] bottom-[18%] rounded-full bg-white px-[0.7cqw] text-[1cqw] font-extrabold text-[#1E2A2E]">
                  +{extra.n}
                </span>
              )}
            </div>
          );
        })}

        {people.map(({ p, pos }) => (
          <Person key={p.userId} p={p} left={pos.left} top={pos.top} z={10 + Math.round(pos.top * 10)} />
        ))}
      </div>
    </div>
  );
}

function Person({ p, left, top, z }: { p: Placed; left: number; top: number; z: number }) {
  const t = useTranslations('Hub.room');
  const prev = useRef<{ left: number; top: number } | null>(null);
  const [walking, setWalking] = useState<{ until: number; flip: boolean } | null>(null);
  const [step, setStep] = useState(false);

  // A new spot means a walk: play the walk frames for as long as the
  // position transition runs, facing the way they go.
  useEffect(() => {
    const before = prev.current;
    prev.current = { left, top };
    if (!before || (before.left === left && before.top === top)) return;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduce) return;
    setWalking({ until: Date.now() + WALK_MS, flip: left < before.left });
    const done = setTimeout(() => setWalking(null), WALK_MS);
    return () => clearTimeout(done);
  }, [left, top]);

  useEffect(() => {
    if (!walking) return;
    const id = setInterval(() => setStep((s) => !s), 220);
    return () => clearInterval(id);
  }, [walking]);

  const frame: Frame = walking ? (step ? 'walk-b' : 'walk-a') : p.pose;
  // The desk sprite carries its own desk, so it is drawn a bit taller.
  const height = frame === 'desk' ? 6.4 : 6.2;

  return (
    <div
      className="absolute flex -translate-x-1/2 -translate-y-full flex-col items-center motion-safe:transition-[left,top] motion-safe:ease-in-out"
      style={{ left: `${left}%`, top: `${top}%`, zIndex: z, transitionDuration: `${WALK_MS}ms` }}
    >
      {/* Bubble */}
      <span className="mb-[0.2cqw] h-[1.6cqw]">
        {walking ? null : p.pose === 'celebrate' ? (
          <span className="animate-bounce text-[1.4cqw]">🎉</span>
        ) : p.away ? (
          <span className="rounded-full bg-white/90 px-[0.5cqw] text-[1cqw]">☕</span>
        ) : p.waiting > 0 ? (
          <span className={cn('rounded-full px-[0.6cqw] py-[0.1cqw] text-[0.9cqw] font-extrabold text-white shadow', p.late ? 'animate-pulse bg-[#F06A5B]' : 'bg-[#25D366]')}>
            💬 {p.waiting}
          </span>
        ) : p.pose === 'desk' ? (
          <span className="flex gap-[0.2cqw] rounded-full bg-white/90 px-[0.5cqw] py-[0.35cqw]">
            {[0, 1, 2].map((d) => (
              <span key={d} className="size-[0.35cqw] animate-bounce rounded-full bg-[#1E2A2E]" style={{ animationDelay: `${d * 150}ms` }} />
            ))}
          </span>
        ) : null}
      </span>
      {/* eslint-disable-next-line @next/next/no-img-element -- sprite */}
      <img
        src={spriteFor(p.look, frame)}
        alt=""
        draggable={false}
        className={cn(
          'w-auto select-none drop-shadow-[0_0.3cqw_0.2cqw_rgba(0,0,0,0.25)]',
          !walking && p.pose === 'celebrate' && 'animate-[hub-jump_0.9s_ease-in-out_infinite]',
          p.away && !walking && 'opacity-70'
        )}
        style={{ height: `${height}cqw`, transform: walking?.flip ? 'scaleX(-1)' : undefined }}
      />
      <span className={cn('mt-[0.2cqw] max-w-[9cqw] truncate rounded-full px-[0.6cqw] text-[0.85cqw] font-bold shadow', p.late ? 'bg-[#F06A5B] text-white' : 'bg-white text-[#1E2A2E]')}>
        {p.name.split(' ')[0]}
        <span className="sr-only"> · {t(`pose.${p.away ? 'away' : p.pose}`)}</span>
      </span>
    </div>
  );
}
