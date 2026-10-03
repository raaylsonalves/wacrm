'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { ChevronLeft, ChevronRight, Plus, Settings } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { cn } from '@/lib/utils';
import { fetchAccountMembers } from '@/lib/account/members';
import { normalizeSettings } from '@/lib/appointments/store';
import {
  appLocaleTag,
  DEFAULT_SETTINGS,
  localParts,
  zonedToUtc,
  type AppointmentSettings,
} from '@/lib/appointments/slots';
import type { AccountMember } from '@/types';
import { AppointmentDialog, type AppointmentDraft } from '@/components/agenda/appointment-dialog';
import { AgendaSettingsDialog } from '@/components/agenda/agenda-settings-dialog';
import { STATUS_CLASS, type Appointment } from '@/components/agenda/types';

type View = 'week' | 'month';

const pad = (n: number) => String(n).padStart(2, '0');

/** A calendar day as a UTC-midnight Date — used only for date arithmetic. */
function dayKey(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function addDays(d: Date, n: number): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + n));
}

/** Monday on or before `d`. */
function startOfWeek(d: Date): Date {
  return addDays(d, -((d.getUTCDay() + 6) % 7));
}

export default function AgendaPage() {
  const t = useTranslations('Agenda');
  const { canSendMessages, canEditSettings, accountId } = useAuth();

  const [settings, setSettings] = useState<AppointmentSettings>(DEFAULT_SETTINGS);
  const [view, setView] = useState<View>('week');
  const [cursor, setCursor] = useState<Date | null>(null);
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  // Time the owner blocked in Google Calendar (migration 096).
  const [blocks, setBlocks] = useState<{ google_event_id: string; starts_at: string; ends_at: string; all_day: boolean }[]>([]);
  const [members, setMembers] = useState<AccountMember[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Appointment | null>(null);
  const [draft, setDraft] = useState<AppointmentDraft | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Bumped on every open so the dialogs remount with fresh form state.
  const [openCount, setOpenCount] = useState(0);

  const tz = settings.timezone;

  const loadSettings = useCallback(async () => {
    const { data } = await createClient()
      .from('appointment_settings')
      .select('*')
      .maybeSingle();
    if (data) setSettings(normalizeSettings(data as Partial<AppointmentSettings>));
  }, []);

  useEffect(() => {
    void loadSettings();
    void fetchAccountMembers().then(setMembers);
  }, [loadSettings]);

  // Start on "today" in the account timezone once settings are known.
  useEffect(() => {
    const p = localParts(new Date(), tz);
    setCursor(new Date(Date.UTC(p.year, p.month - 1, p.day)));
  }, [tz]);

  const days = useMemo(() => {
    if (!cursor) return [];
    if (view === 'week') {
      const start = startOfWeek(cursor);
      return Array.from({ length: 7 }, (_, i) => addDays(start, i));
    }
    const first = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), 1));
    const start = startOfWeek(first);
    return Array.from({ length: 42 }, (_, i) => addDays(start, i));
  }, [cursor, view]);

  // Navigation and realtime events can overlap; only the newest request
  // may write, so a slow earlier range never overwrites the current one.
  const loadSeq = useRef(0);
  const load = useCallback(async () => {
    if (days.length === 0) return;
    const seq = ++loadSeq.current;
    const first = days[0];
    const after = addDays(days[days.length - 1], 1);
    const from = zonedToUtc(first.getUTCFullYear(), first.getUTCMonth() + 1, first.getUTCDate(), 0, 0, tz);
    const to = zonedToUtc(after.getUTCFullYear(), after.getUTCMonth() + 1, after.getUTCDate(), 0, 0, tz);
    const supabase = createClient();
    const [{ data }, { data: busy }] = await Promise.all([
      supabase
        .from('appointments')
        .select('*, contact:contacts(id, name, phone)')
        .gte('starts_at', from.toISOString())
        .lt('starts_at', to.toISOString())
        .order('starts_at'),
      supabase
        .from('calendar_busy_blocks')
        .select('google_event_id, starts_at, ends_at, all_day')
        .lt('starts_at', to.toISOString())
        .gt('ends_at', from.toISOString())
        .order('starts_at'),
    ]);
    if (seq !== loadSeq.current) return;
    setAppointments((data as Appointment[] | null) ?? []);
    setBlocks((busy as typeof blocks | null) ?? []);
  }, [days, tz]);

  useEffect(() => {
    void load();
  }, [load]);

  // Live-refresh when the bot books a slot or a teammate edits one.
  useEffect(() => {
    if (!accountId) return;
    const supabase = createClient();
    const channel = supabase
      .channel(`appointments:${accountId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'appointments', filter: `account_id=eq.${accountId}` },
        () => void load(),
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [accountId, load]);

  const byDay = useMemo(() => {
    const map = new Map<string, Appointment[]>();
    for (const a of appointments) {
      const p = localParts(new Date(a.starts_at), tz);
      const key = `${p.year}-${pad(p.month)}-${pad(p.day)}`;
      map.set(key, [...(map.get(key) ?? []), a]);
    }
    return map;
  }, [appointments, tz]);

  // A Google block shows on every local day it touches.
  const blocksByDay = useMemo(() => {
    const map = new Map<string, typeof blocks>();
    for (const b of blocks) {
      const end = new Date(new Date(b.ends_at).getTime() - 1);
      for (let d = new Date(b.starts_at); d <= end; d = new Date(d.getTime() + 86_400_000)) {
        const p = localParts(d, tz);
        const key = `${p.year}-${pad(p.month)}-${pad(p.day)}`;
        if (!(map.get(key) ?? []).includes(b)) map.set(key, [...(map.get(key) ?? []), b]);
      }
    }
    return map;
  }, [blocks, tz]);

  // Back from Google's consent screen (the callback redirects with ?google=).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const result = params.get('google');
    if (!result) return;
    if (result === 'connected') toast.success(t('google.connectedToast'));
    else toast.error(t.has(`google.errors.${result}`) ? t(`google.errors.${result}`) : t('google.failed'));
    params.delete('google');
    const qs = params.toString();
    window.history.replaceState(null, '', `${window.location.pathname}${qs ? `?${qs}` : ''}`);
  }, [t]);

  const todayKey = useMemo(() => {
    const p = localParts(new Date(), tz);
    return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
  }, [tz]);

  function shift(direction: 1 | -1) {
    if (!cursor) return;
    setCursor(
      view === 'week'
        ? addDays(cursor, 7 * direction)
        : new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + direction, 1)),
    );
  }

  function openNew(day?: Date) {
    setEditing(null);
    setDraft({ date: dayKey(day ?? cursor ?? new Date()), time: settings.day_start.slice(0, 5) });
    setOpenCount((n) => n + 1);
    setDialogOpen(true);
  }

  function openEdit(a: Appointment) {
    setEditing(a);
    setDraft(null);
    setOpenCount((n) => n + 1);
    setDialogOpen(true);
  }

  const timeOf = (iso: string) => {
    const p = localParts(new Date(iso), tz);
    return `${pad(p.hour)}:${pad(p.minute)}`;
  };

  const heading = cursor
    ? new Intl.DateTimeFormat(appLocaleTag(), {
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC',
      }).format(view === 'week' ? startOfWeek(cursor) : cursor)
    : '';

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {/* The page title lives in the shell header; this row is actions only. */}
        <h1 className="sr-only">{t('title')}</h1>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {canEditSettings && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setOpenCount((n) => n + 1);
                setSettingsOpen(true);
              }}
            >
              <Settings className="size-4" />
              <span className="hidden sm:inline">{t('settings.button')}</span>
            </Button>
          )}
          {canSendMessages && (
            <Button size="sm" onClick={() => openNew()}>
              <Plus className="size-4" />
              {t('new')}
            </Button>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="icon-lg" className="bg-card size-10" onClick={() => shift(-1)} aria-label={t('previous')}>
          <ChevronLeft className="size-4" />
        </Button>
        <Button
          variant="outline"
          className="bg-card h-10 px-4"
          onClick={() => {
            const p = localParts(new Date(), tz);
            setCursor(new Date(Date.UTC(p.year, p.month - 1, p.day)));
          }}
        >
          {t('today')}
        </Button>
        <Button variant="outline" size="icon-lg" className="bg-card size-10" onClick={() => shift(1)} aria-label={t('next')}>
          <ChevronRight className="size-4" />
        </Button>
        <span className="text-muted-foreground text-sm font-medium first-letter:uppercase">{heading}</span>
        <div className="ml-auto flex gap-1.5">
          {(['week', 'month'] as View[]).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              className={cn(
                'min-h-10 rounded-full border px-4 text-[13px] font-semibold transition-colors duration-150 ease-out',
                view === v
                  ? 'bg-foreground text-background border-transparent'
                  : 'border-border text-foreground hover:bg-card',
              )}
            >
              {t(`view.${v}`)}
            </button>
          ))}
        </div>
      </div>

      {/* Phones: a week is a strip of 7 days + the chosen day's list —
          seven 50px columns can't show a readable appointment. */}
      {view === 'week' && cursor && (
        <div className="space-y-3 md:hidden">
          <div className="grid grid-cols-7 gap-1">
            {days.map((day) => {
              const key = dayKey(day);
              const selected = key === dayKey(cursor);
              const count = (byDay.get(key) ?? []).length;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setCursor(day)}
                  className={cn(
                    'flex flex-col items-center gap-0.5 rounded-2xl py-2 text-xs transition-colors duration-150 ease-out',
                    selected ? 'bg-foreground text-background' : 'text-muted-foreground',
                    !selected && key === todayKey && 'bg-card text-foreground font-semibold',
                  )}
                >
                  <span>{t(`weekdays.${day.getUTCDay()}`)}</span>
                  <span className="text-base font-semibold tabular-nums">{day.getUTCDate()}</span>
                  <span
                    className={cn(
                      'h-1.5 w-1.5 rounded-full',
                      count > 0 ? 'bg-tone-salmon' : 'bg-transparent',
                    )}
                  />
                </button>
              );
            })}
          </div>

          <div className="space-y-2">
            <p className="text-sm font-medium first-letter:uppercase">
              {new Intl.DateTimeFormat(appLocaleTag(), {
                weekday: 'long',
                day: 'numeric',
                month: 'long',
                timeZone: 'UTC',
              }).format(cursor)}
            </p>
            {(blocksByDay.get(dayKey(cursor)) ?? []).map((b) => (
              <div
                key={`${b.google_event_id}-${b.starts_at}`}
                className="text-muted-foreground flex items-center gap-3 rounded-2xl border border-dashed bg-[repeating-linear-gradient(135deg,transparent,transparent_6px,var(--muted)_6px,var(--muted)_12px)] p-3 text-sm"
              >
                <span className="w-12 shrink-0 font-semibold tabular-nums">
                  {b.all_day ? t('google.allDay') : timeOf(b.starts_at)}
                </span>
                {t('google.busy')}
              </div>
            ))}
            {(byDay.get(dayKey(cursor)) ?? []).length === 0 && (blocksByDay.get(dayKey(cursor)) ?? []).length === 0 ? (
              <p className="text-muted-foreground rounded-[20px] border border-dashed p-6 text-center text-sm">
                {settings.work_days.includes(cursor.getUTCDay()) ? t('mobile.empty') : t('mobile.closed')}
              </p>
            ) : (
              (byDay.get(dayKey(cursor)) ?? []).map((a) => (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => openEdit(a)}
                  className={cn('flex w-full items-start gap-3 rounded-2xl border p-3 text-left', STATUS_CLASS[a.status])}
                >
                  <span className="w-12 shrink-0 text-sm font-semibold tabular-nums">{timeOf(a.starts_at)}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{a.title}</span>
                    <span className="block truncate text-xs opacity-80">
                      {a.contact?.name ?? a.contact?.phone}
                    </span>
                  </span>
                  <span className="shrink-0 text-[11px] opacity-80">{t(`status.${a.status}`)}</span>
                </button>
              ))
            )}
            {canSendMessages && (
              <Button variant="outline" size="sm" className="w-full" onClick={() => openNew(cursor)}>
                <Plus className="size-4" />
                {t('mobile.newOnDay')}
              </Button>
            )}
          </div>
        </div>
      )}

      <div
        className={cn(
          'grid grid-cols-7 gap-px overflow-hidden rounded-[24px] border border-border bg-border text-xs',
          view === 'week' && 'hidden md:grid',
        )}
      >
        {[1, 2, 3, 4, 5, 6, 0].map((d) => (
          <div key={d} className="bg-card text-muted-foreground px-2.5 py-2 font-semibold">
            {t(`weekdays.${d}`)}
          </div>
        ))}
        {days.map((day) => {
          const key = dayKey(day);
          const items = byDay.get(key) ?? [];
          const outside = view === 'month' && cursor && day.getUTCMonth() !== cursor.getUTCMonth();
          const closed = !settings.work_days.includes(day.getUTCDay());
          return (
            <div
              key={key}
              onClick={() => {
                // Phones: the month grid is an overview — a tap opens the day.
                if (view === 'month' && window.matchMedia('(max-width: 767px)').matches) {
                  setCursor(day);
                  setView('week');
                }
              }}
              className={cn(
                'bg-card group flex min-w-0 flex-col gap-1 p-2',
                view === 'week' ? 'min-h-72' : 'min-h-14 md:min-h-24',
                (outside || closed) && 'bg-muted/40',
              )}
            >
              <div className="flex items-center justify-between">
                <span
                  className={cn(
                    'rounded-full px-2 py-0.5 text-[13px] font-bold tabular-nums',
                    key === todayKey && 'bg-foreground text-background',
                    outside && 'text-muted-foreground',
                  )}
                >
                  {day.getUTCDate()}
                </span>
                {canSendMessages && (
                  <button
                    type="button"
                    onClick={() => openNew(day)}
                    className="text-muted-foreground hover:text-foreground opacity-0 group-hover:opacity-100 focus:opacity-100"
                    aria-label={t('new')}
                  >
                    <Plus className="size-3.5" />
                  </button>
                )}
              </div>
              {view === 'month' && items.length > 0 && (
                <span className="flex flex-wrap gap-0.5 md:hidden">
                  {items.slice(0, 4).map((a) => (
                    <span key={a.id} className="bg-tone-salmon h-1.5 w-1.5 rounded-full" />
                  ))}
                </span>
              )}
              {(blocksByDay.get(key) ?? []).map((b) => (
                <div
                  key={`${b.google_event_id}-${b.starts_at}`}
                  title={t('google.busyTitle')}
                  className={cn(
                    'text-muted-foreground w-full truncate rounded-[10px] border border-dashed bg-[repeating-linear-gradient(135deg,transparent,transparent_5px,var(--muted)_5px,var(--muted)_10px)] px-2 py-1',
                    view === 'month' && 'hidden md:block',
                  )}
                >
                  <span className="font-medium">{b.all_day ? t('google.allDay') : timeOf(b.starts_at)}</span>{' '}
                  {t('google.busy')}
                </div>
              ))}
              {items.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    openEdit(a);
                  }}
                  className={cn(
                    'w-full truncate rounded-[10px] border px-2 py-1 text-left transition-[filter] duration-150 ease-out hover:brightness-95',
                    view === 'month' && 'hidden md:block',
                    STATUS_CLASS[a.status],
                  )}
                  title={`${timeOf(a.starts_at)} ${a.title} — ${a.contact?.name ?? a.contact?.phone ?? ''}`}
                >
                  <span className="font-medium">{timeOf(a.starts_at)}</span>{' '}
                  {view === 'week' ? (
                    <>
                      {a.title}
                      <span className="block truncate opacity-80">
                        {a.contact?.name ?? a.contact?.phone}
                      </span>
                    </>
                  ) : (
                    a.contact?.name ?? a.title
                  )}
                </button>
              ))}
            </div>
          );
        })}
      </div>

      <p className="text-muted-foreground text-xs">
        {t('hoursSummary', {
          start: settings.day_start.slice(0, 5),
          end: settings.day_end.slice(0, 5),
          tz,
        })}
      </p>

      <AppointmentDialog
        key={`appt-${openCount}`}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        appointment={editing}
        draft={draft}
        timezone={tz}
        slotMinutes={settings.slot_minutes}
        members={members}
        onSaved={load}
      />
      {canEditSettings && (
        <AgendaSettingsDialog
          key={`settings-${openCount}`}
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          settings={settings}
          onSaved={loadSettings}
        />
      )}
    </div>
  );
}
