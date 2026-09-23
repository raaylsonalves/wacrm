'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { CalendarDays, ChevronLeft, ChevronRight, Plus, Settings } from 'lucide-react';

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
    const { data } = await createClient()
      .from('appointments')
      .select('*, contact:contacts(id, name, phone)')
      .gte('starts_at', from.toISOString())
      .lt('starts_at', to.toISOString())
      .order('starts_at');
    if (seq !== loadSeq.current) return;
    setAppointments((data as Appointment[] | null) ?? []);
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
        <CalendarDays className="text-primary size-5" />
        <h1 className="text-xl font-semibold">{t('title')}</h1>
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
              {t('settings.button')}
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
        <Button variant="outline" size="icon-sm" onClick={() => shift(-1)} aria-label={t('previous')}>
          <ChevronLeft className="size-4" />
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            const p = localParts(new Date(), tz);
            setCursor(new Date(Date.UTC(p.year, p.month - 1, p.day)));
          }}
        >
          {t('today')}
        </Button>
        <Button variant="outline" size="icon-sm" onClick={() => shift(1)} aria-label={t('next')}>
          <ChevronRight className="size-4" />
        </Button>
        <span className="text-sm font-medium capitalize">{heading}</span>
        <div className="border-border ml-auto flex rounded-md border p-0.5">
          {(['week', 'month'] as View[]).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              className={cn(
                'rounded px-3 py-1 text-sm',
                view === v ? 'bg-primary text-primary-foreground' : 'text-muted-foreground',
              )}
            >
              {t(`view.${v}`)}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-7 gap-px overflow-hidden rounded-lg border border-border bg-border text-xs">
        {[1, 2, 3, 4, 5, 6, 0].map((d) => (
          <div key={d} className="bg-muted text-muted-foreground px-2 py-1.5 font-medium">
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
              className={cn(
                'bg-card group flex min-w-0 flex-col gap-1 p-1.5',
                view === 'week' ? 'min-h-72' : 'min-h-24',
                (outside || closed) && 'bg-muted/40',
              )}
            >
              <div className="flex items-center justify-between">
                <span
                  className={cn(
                    'rounded px-1 font-medium',
                    key === todayKey && 'bg-primary text-primary-foreground',
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
              {items.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => openEdit(a)}
                  className={cn(
                    'w-full truncate rounded border px-1.5 py-1 text-left',
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
