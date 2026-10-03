'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import {
  appLocaleTag,
  generateFreeSlots,
  localParts,
  zonedToUtc,
  type AppointmentSettings,
  type BusyRange,
} from '@/lib/appointments/slots';
import { eventToneClass, type Appointment } from '@/components/agenda/types';
import type { AccountMember } from '@/types';

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * Right column of the v2 week view: the picked appointment (who booked it,
 * when, status, owner, notes, shortcuts) and that day's free times — or,
 * with nothing picked, the next bookings of the week.
 */
export function AppointmentAside({
  selected,
  week,
  members,
  settings,
  busy,
  canCreate,
  onPick,
  onEdit,
  onNew,
}: {
  selected: Appointment | null;
  /** This week's appointments, in start order. */
  week: Appointment[];
  members: AccountMember[];
  settings: AppointmentSettings;
  /** Everything that blocks a slot (appointments + Google busy time). */
  busy: BusyRange[];
  canCreate: boolean;
  onPick: (a: Appointment) => void;
  onEdit: (a: Appointment) => void;
  onNew: (day: Date, time: string) => void;
}) {
  const t = useTranslations('Agenda');
  const tz = settings.timezone;
  const locale = appLocaleTag();
  const time = (iso: string) => {
    const p = localParts(new Date(iso), tz);
    return `${pad(p.hour)}:${pad(p.minute)}`;
  };
  const dayLabel = (iso: string) =>
    new Intl.DateTimeFormat(locale, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      timeZone: tz,
    }).format(new Date(iso));

  // Free times left on the picked appointment's day (from now on).
  const free = useMemo(() => {
    if (!selected) return { day: null as Date | null, slots: [] as Date[] };
    const p = localParts(new Date(selected.starts_at), tz);
    const dayStart = zonedToUtc(p.year, p.month, p.day, 0, 0, tz);
    const now = new Date(Math.max(Date.now(), dayStart.getTime()));
    const sameDay = (d: Date) => {
      const q = localParts(d, tz);
      return q.year === p.year && q.month === p.month && q.day === p.day;
    };
    const slots = generateFreeSlots({
      now,
      settings,
      busy,
      daysAhead: 0,
      limit: 8,
    }).filter(sameDay);
    return { day: new Date(Date.UTC(p.year, p.month - 1, p.day)), slots };
  }, [selected, settings, busy, tz]);

  if (!selected) {
    const next = week
      .filter(
        (a) =>
          new Date(a.ends_at).getTime() >= Date.now() &&
          a.status !== 'cancelled'
      )
      .slice(0, 5);
    return (
      <div className="border-border bg-card flex flex-col gap-2.5 rounded-[22px] border p-4">
        <span className="text-muted-foreground text-xs font-bold">
          {t('grid.upcoming')}
        </span>
        {next.length === 0 ? (
          <p className="text-muted-foreground text-[13px]">
            {t('grid.noUpcoming')}
          </p>
        ) : (
          next.map((a) => (
            <button
              key={a.id}
              type="button"
              onClick={() => onPick(a)}
              className="hover:bg-muted -mx-2 flex items-center gap-3 rounded-2xl px-2 py-1.5 text-left transition-colors duration-150 ease-out"
            >
              <span
                className={cn(
                  'w-14 shrink-0 rounded-full py-0.5 text-center text-xs font-bold tabular-nums',
                  eventToneClass(a)
                )}
              >
                {time(a.starts_at)}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-semibold">
                  {a.contact?.name ?? a.contact?.phone ?? a.title}
                </span>
                <span className="text-muted-foreground block truncate text-xs first-letter:uppercase">
                  {dayLabel(a.starts_at)} · {a.title}
                </span>
              </span>
            </button>
          ))
        )}
      </div>
    );
  }

  const owner = members.find(
    (m) => m.user_id === selected.assigned_to
  )?.full_name;
  return (
    <div className="flex flex-col gap-3">
      <div
        className={cn(
          'flex flex-col gap-1.5 rounded-[24px] border p-[18px]',
          eventToneClass(selected)
        )}
      >
        <span className="text-xs font-bold">
          {t(`grid.source.${selected.source}`)}
        </span>
        <strong className="text-lg leading-tight font-bold">
          {selected.contact?.name ?? selected.contact?.phone ?? selected.title}
        </strong>
        <span className="text-[13.5px] first-letter:uppercase">
          {dayLabel(selected.starts_at)} · {time(selected.starts_at)}–
          {time(selected.ends_at)}
          <br />
          {selected.title}
        </span>
      </div>

      <div className="border-border bg-card flex flex-col gap-2.5 rounded-[22px] border p-4 text-[13px]">
        <div className="flex justify-between gap-3">
          <span>{t('grid.status')}</span>
          <span className="text-muted-foreground">
            {t(`status.${selected.status}`)}
          </span>
        </div>
        <div className="flex justify-between gap-3">
          <span>{t('grid.owner')}</span>
          <span className="text-muted-foreground truncate">
            {owner ?? t('grid.noOwner')}
          </span>
        </div>
        {selected.notes && (
          <p className="text-muted-foreground border-border border-t pt-2.5 leading-relaxed">
            {selected.notes}
          </p>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        {selected.conversation_id && (
          <Link
            href={`/inbox?c=${selected.conversation_id}`}
            className="bg-foreground text-background hover:bg-foreground/90 inline-flex min-h-10 items-center rounded-full px-4 text-[13px] font-semibold transition-colors duration-150 ease-out"
          >
            {t('grid.openConversation')}
          </Link>
        )}
        <button
          type="button"
          onClick={() => onEdit(selected)}
          className="border-border bg-card hover:bg-muted inline-flex min-h-10 items-center rounded-full border px-4 text-[13px] font-semibold transition-colors duration-150 ease-out"
        >
          {t('grid.edit')}
        </button>
      </div>

      {free.day && (
        <div className="border-border bg-card flex flex-col gap-2 rounded-[22px] border p-4">
          <span className="text-muted-foreground text-xs font-bold first-letter:uppercase">
            {t('grid.freeOn', { day: dayLabel(selected.starts_at) })}
          </span>
          {free.slots.length === 0 ? (
            <p className="text-muted-foreground text-[13px]">
              {t('grid.noFree')}
            </p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {free.slots.map((s) => (
                <button
                  key={s.toISOString()}
                  type="button"
                  disabled={!canCreate}
                  onClick={() => onNew(free.day!, time(s.toISOString()))}
                  className="border-border hover:bg-muted rounded-full border px-3 py-1 text-[12.5px] tabular-nums transition-colors duration-150 ease-out disabled:pointer-events-none"
                >
                  {time(s.toISOString())}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
