'use client';

import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import { placeTeam, spriteFor, type Placed, type RoomId, type RoomMemberInput } from '@/lib/dashboard/room';

/**
 * The live room for the TV hub (specs/painel-gestor.md phase 5). Five
 * isometric floors (generated art in public/hub) on a 16:9 stage; each
 * person stands where their state puts them (lib/dashboard/room) and
 * walks there when it changes. Everything is laid out in % of the stage
 * and sized in container units, so it scales with any screen.
 */

// Stage boxes in % (left, top, width) — the same layout as the approved
// reference scene: management top-left, service in the middle,
// celebration top-right, reception bottom-left, negotiation bottom-right.
const BOX: Record<RoomId, { left: number; top: number; width: number; dot: string }> = {
  gestao: { left: 1.5, top: 3, width: 33, dot: 'bg-[#F5A99A]' },
  atendimento: { left: 31, top: 22, width: 38, dot: 'bg-[#9CC9F5]' },
  comemoracao: { left: 70, top: 4, width: 28, dot: 'bg-[#F7D774]' },
  recepcao: { left: 2, top: 52, width: 31, dot: 'bg-[#8FD9C4]' },
  negociacao: { left: 69, top: 50, width: 29, dot: 'bg-[#C9B6F2]' },
};

// Where people stand inside each room image, in % of that image (feet).
const SLOTS: Record<RoomId, [number, number][]> = {
  gestao: [[36, 66], [56, 72], [22, 56]],
  atendimento: [[30, 62], [50, 46], [50, 80], [70, 64], [18, 44], [36, 34], [64, 34], [82, 50]],
  comemoracao: [[42, 60], [58, 66], [28, 66], [52, 50]],
  recepcao: [[46, 60], [30, 68], [60, 70], [22, 52]],
  negociacao: [[44, 58], [62, 64], [30, 66]],
};

const ORDER: RoomId[] = ['gestao', 'comemoracao', 'atendimento', 'recepcao', 'negociacao'];

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

  return (
    <div className="relative h-full w-full overflow-hidden rounded-[28px] bg-[#1E2A2E] [container-type:size]">
      <div className="absolute top-1/2 left-1/2 aspect-video w-full max-h-full -translate-x-1/2 -translate-y-1/2 [container-type:inline-size]" style={{ maxWidth: 'calc(100cqh * 16 / 9)' }}>
        {ORDER.map((room) => {
          const box = BOX[room];
          const people = byRoom.get(room) ?? [];
          const slots = SLOTS[room];
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

              {people.slice(0, slots.length).map((p, i) => (
                <Person key={p.userId} p={p} x={slots[i][0]} y={slots[i][1]} />
              ))}
              {people.length > slots.length && (
                <span className="absolute right-[6%] bottom-[18%] rounded-full bg-white px-[0.7cqw] text-[1cqw] font-extrabold text-[#1E2A2E]">
                  +{people.length - slots.length}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Person({ p, x, y }: { p: Placed; x: number; y: number }) {
  const t = useTranslations('Hub.room');
  const src = spriteFor(p.look, p.pose);
  // The desk sprite carries its own desk, so it is drawn wider.
  const height = p.look === 0 && p.pose === 'desk' ? 6.4 : 6.2;
  return (
    <div
      className="absolute flex -translate-x-1/2 -translate-y-full flex-col items-center"
      style={{ left: `${x}%`, top: `${y}%` }}
    >
      {/* Bubble */}
      <span className="mb-[0.2cqw] h-[1.6cqw]">
        {p.pose === 'celebrate' ? (
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
        src={src}
        alt=""
        draggable={false}
        className={cn('w-auto select-none drop-shadow-[0_0.3cqw_0.2cqw_rgba(0,0,0,0.25)]', p.pose === 'celebrate' && 'animate-[hub-jump_0.9s_ease-in-out_infinite]', p.away && 'opacity-70')}
        style={{ height: `${height}cqw` }}
      />
      <span className={cn('mt-[0.2cqw] max-w-[9cqw] truncate rounded-full px-[0.6cqw] text-[0.85cqw] font-bold shadow', p.late ? 'bg-[#F06A5B] text-white' : 'bg-white text-[#1E2A2E]')}>
        {p.name.split(' ')[0]}
        <span className="sr-only"> · {t(`pose.${p.away ? 'away' : p.pose}`)}</span>
      </span>
    </div>
  );
}
