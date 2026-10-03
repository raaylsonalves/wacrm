'use client';

import { useMemo, type MouseEvent } from 'react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import {
  localParts,
  parseClock,
  type AppointmentSettings,
} from '@/lib/appointments/slots';
import {
  HOUR_PX,
  gridRange,
  minuteAt,
  placeItems,
  type GridItem,
} from '@/components/agenda/time-grid';
import { eventToneClass, type Appointment } from '@/components/agenda/types';

export interface BusyBlock {
  google_event_id: string;
  starts_at: string;
  ends_at: string;
  all_day: boolean;
}

const pad = (n: number) => String(n).padStart(2, '0');
const keyOf = (d: Date) =>
  `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const clock = (m: number) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;

/**
 * v2 week view: an hour grid with each appointment placed at its time and
 * sized by its duration (overlaps side by side), the account's working
 * days only, today tinted. Clicking an empty spot starts a new booking at
 * that time.
 */
export function WeekTimeGrid({
  days,
  byDay,
  blocksByDay,
  settings,
  todayKey,
  selectedId,
  canCreate,
  onPick,
  onNew,
}: {
  days: Date[];
  byDay: Map<string, Appointment[]>;
  blocksByDay: Map<string, BusyBlock[]>;
  settings: AppointmentSettings;
  todayKey: string;
  selectedId: string | null;
  canCreate: boolean;
  onPick: (a: Appointment) => void;
  onNew: (day: Date, time: string) => void;
}) {
  const t = useTranslations('Agenda');
  const tz = settings.timezone;

  // Minutes since local midnight, clamped to the day it starts on.
  const minutes = useMemo(() => {
    const of = (iso: string) => {
      const p = localParts(new Date(iso), tz);
      return p.hour * 60 + p.minute;
    };
    return (startIso: string, endIso: string) => {
      const start = of(startIso);
      const sameDay = ymd(startIso, tz).join('-') === ymd(endIso, tz).join('-');
      return {
        startMin: start,
        endMin: sameDay ? Math.max(of(endIso), start + 15) : 24 * 60,
      };
    };
  }, [tz]);

  const cols = useMemo(() => {
    const busy = (d: Date) =>
      (byDay.get(keyOf(d)) ?? []).length +
        (blocksByDay.get(keyOf(d)) ?? []).length >
      0;
    const shown = days.filter(
      (d) => settings.work_days.includes(d.getUTCDay()) || busy(d)
    );
    return shown.length ? shown : days;
  }, [days, byDay, blocksByDay, settings.work_days]);

  const items = useMemo(() => {
    const all: GridItem[] = [];
    for (const d of cols) {
      for (const a of byDay.get(keyOf(d)) ?? [])
        all.push({ id: a.id, ...minutes(a.starts_at, a.ends_at) });
      for (const b of blocksByDay.get(keyOf(d)) ?? [])
        if (!b.all_day)
          all.push({
            id: b.google_event_id,
            ...minutes(b.starts_at, b.ends_at),
          });
    }
    return all;
  }, [cols, byDay, blocksByDay, minutes]);

  const { from, to } = gridRange(
    parseClock(settings.day_start),
    parseClock(settings.day_end),
    items
  );
  const hours = Array.from(
    { length: (to - from) / 60 },
    (_, i) => from + i * 60
  );
  const height = hours.length * HOUR_PX;

  const startNew = (day: Date) => (e: MouseEvent<HTMLDivElement>) => {
    if (!canCreate || e.target !== e.currentTarget) return;
    const y = e.clientY - e.currentTarget.getBoundingClientRect().top;
    onNew(day, clock(minuteAt(y, from, settings.slot_minutes || 30)));
  };

  return (
    <div className="space-y-2.5">
      <div className="border-border bg-card overflow-x-auto rounded-[24px] border p-2">
        <div
          className="grid min-w-[660px]"
          style={{
            gridTemplateColumns: `56px repeat(${cols.length}, minmax(110px, 1fr))`,
          }}
        >
          <div />
          {cols.map((day) => {
            const today = keyOf(day) === todayKey;
            return (
              <div key={keyOf(day)} className="flex flex-col gap-0.5 p-2.5">
                <span className="text-muted-foreground text-xs">
                  {t(`weekdays.${day.getUTCDay()}`)}
                </span>
                <span
                  className={cn(
                    'self-start rounded-full px-2 py-0.5 text-base font-bold tabular-nums',
                    today && 'bg-foreground text-background'
                  )}
                >
                  {day.getUTCDate()}
                </span>
              </div>
            );
          })}

          <div className="flex flex-col" aria-hidden>
            {hours.map((m) => (
              <span
                key={m}
                className="text-muted-foreground px-2 text-[11px] tabular-nums"
                style={{ height: HOUR_PX }}
              >
                {clock(m)}
              </span>
            ))}
          </div>

          {cols.map((day) => {
            const key = keyOf(day);
            const today = key === todayKey;
            const closed = !settings.work_days.includes(day.getUTCDay());
            const appts = byDay.get(key) ?? [];
            const blocks = (blocksByDay.get(key) ?? []).filter(
              (b) => !b.all_day
            );
            const placed = new Map(
              placeItems(
                [
                  ...appts.map((a) => ({
                    id: a.id,
                    ...minutes(a.starts_at, a.ends_at),
                  })),
                  ...blocks.map((b) => ({
                    id: b.google_event_id,
                    ...minutes(b.starts_at, b.ends_at),
                  })),
                ],
                from
              ).map((p) => [p.id, p])
            );
            const box = (id: string) => {
              const p = placed.get(id)!;
              return {
                top: p.top,
                height: p.height,
                left: `calc(${(p.lane / p.lanes) * 100}% + 5px)`,
                width: `calc(${100 / p.lanes}% - 10px)`,
              };
            };
            return (
              <div
                key={key}
                onClick={startNew(day)}
                className={cn(
                  'border-border relative border-l',
                  today && 'bg-muted/60',
                  closed &&
                    'bg-[repeating-linear-gradient(135deg,transparent,transparent_6px,var(--muted)_6px,var(--muted)_12px)]',
                  canCreate && 'cursor-copy'
                )}
                style={{
                  height,
                  // Faint hour lines under the events.
                  backgroundImage: closed
                    ? undefined
                    : `repeating-linear-gradient(to bottom, transparent 0, transparent ${HOUR_PX - 1}px, color-mix(in oklch, var(--border) 70%, transparent) ${HOUR_PX - 1}px, color-mix(in oklch, var(--border) 70%, transparent) ${HOUR_PX}px)`,
                }}
              >
                {blocks.map((b) => (
                  <div
                    key={b.google_event_id}
                    title={t('google.busyTitle')}
                    className="text-muted-foreground border-border pointer-events-none absolute overflow-hidden rounded-[14px] border border-dashed bg-[repeating-linear-gradient(135deg,transparent,transparent_5px,var(--muted)_5px,var(--muted)_10px)] px-2 py-1 text-[11px]"
                    style={box(b.google_event_id)}
                  >
                    {t('google.busy')}
                  </div>
                ))}
                {appts.map((a) => {
                  const m = minutes(a.starts_at, a.ends_at);
                  return (
                    <button
                      key={a.id}
                      type="button"
                      onClick={() => onPick(a)}
                      aria-pressed={selectedId === a.id}
                      title={`${clock(m.startMin)} ${a.title} — ${a.contact?.name ?? a.contact?.phone ?? ''}`}
                      className={cn(
                        'absolute overflow-hidden rounded-[14px] border px-2.5 py-1.5 text-left text-xs leading-snug transition-[filter,box-shadow] duration-150 ease-out hover:brightness-95',
                        eventToneClass(a),
                        selectedId === a.id && 'ring-foreground ring-2'
                      )}
                      style={box(a.id)}
                    >
                      <strong className="block truncate font-bold">
                        {a.contact?.name ?? a.contact?.phone ?? a.title}
                      </strong>
                      <span className="block truncate">
                        {clock(m.startMin)} · {a.title}
                      </span>
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
      <div className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 px-1.5 text-[12.5px]">
        <span className="inline-flex items-center gap-1.5">
          <span className="bg-tone-mint size-3 rounded" />
          {t('grid.legendAuto')}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="bg-tone-lilac size-3 rounded" />
          {t('grid.legendTeam')}
        </span>
      </div>
    </div>
  );
}

function ymd(iso: string, tz: string): [number, number, number] {
  const p = localParts(new Date(iso), tz);
  return [p.year, p.month - 1, p.day];
}
