// Pure scheduling helpers — no I/O, so both the dashboard and the
// offer_slots flow node share one tested implementation. Timezone math
// uses Intl only (no tz library): business hours are stored as local
// wall-clock times plus an IANA zone, and every conversion goes through
// zonedToUtc / localParts below.

export interface AppointmentSettings {
  timezone: string;
  work_days: number[];
  day_start: string; // "HH:MM" or "HH:MM:SS"
  day_end: string;
  slot_minutes: number;
  reminder_enabled: boolean;
  reminder_hours_before: number;
  reminder_text: string;
}

export const DEFAULT_SETTINGS: AppointmentSettings = {
  timezone: 'America/Sao_Paulo',
  work_days: [1, 2, 3, 4, 5],
  day_start: '09:00',
  day_end: '18:00',
  slot_minutes: 30,
  reminder_enabled: true,
  reminder_hours_before: 24,
  reminder_text:
    'Olá {{nome}}! Lembrete do seu agendamento em {{data}} às {{hora}}. Até lá!',
};

/** True when `tz` is an IANA zone this runtime's Intl understands. */
export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const LOCALE_TAGS: Record<string, string> = { pt: 'pt-BR', en: 'en-US', es: 'es', ko: 'ko' };

/** BCP 47 tag for the build-time app locale (NEXT_PUBLIC_APP_LOCALE). */
export function appLocaleTag(): string {
  return LOCALE_TAGS[process.env.NEXT_PUBLIC_APP_LOCALE ?? 'en'] ?? 'en-US';
}

export interface BusyRange {
  start: Date;
  end: Date;
}

interface LocalParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
}

export function localParts(date: Date, timeZone: string): LocalParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value ?? 0);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour') % 24,
    minute: get('minute'),
  };
}

function offsetMs(date: Date, timeZone: string): number {
  const p = localParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  const truncated = Math.floor(date.getTime() / 60_000) * 60_000;
  return asUtc - truncated;
}

/** Wall-clock time in `timeZone` → the UTC instant it denotes. */
export function zonedToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  let result = guess - offsetMs(new Date(guess), timeZone);
  // Second pass settles instants that straddle a DST transition.
  result = guess - offsetMs(new Date(result), timeZone);
  return new Date(result);
}

export function parseClock(value: string): number {
  const [h, m] = value.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

function overlaps(start: Date, end: Date, busy: BusyRange[]): boolean {
  return busy.some((b) => start < b.end && end > b.start);
}

/**
 * Next free slot start times, in order, within business hours.
 * A slot is free when [start, start + duration) touches no busy range
 * and starts after `now`.
 */
export function generateFreeSlots(opts: {
  now: Date;
  settings: Pick<
    AppointmentSettings,
    'timezone' | 'work_days' | 'day_start' | 'day_end' | 'slot_minutes'
  >;
  busy: BusyRange[];
  daysAhead: number;
  limit: number;
  durationMinutes?: number;
}): Date[] {
  const { now, settings, busy, daysAhead, limit } = opts;
  const duration = opts.durationMinutes ?? settings.slot_minutes;
  const startMin = parseClock(settings.day_start);
  const endMin = parseClock(settings.day_end);
  const today = localParts(now, settings.timezone);
  const slots: Date[] = [];

  for (let offset = 0; offset <= daysAhead && slots.length < limit; offset++) {
    const d = new Date(Date.UTC(today.year, today.month - 1, today.day + offset));
    if (!settings.work_days.includes(d.getUTCDay())) continue;
    for (
      let m = startMin;
      m + duration <= endMin && slots.length < limit;
      m += settings.slot_minutes
    ) {
      const start = zonedToUtc(
        d.getUTCFullYear(),
        d.getUTCMonth() + 1,
        d.getUTCDate(),
        Math.floor(m / 60),
        m % 60,
        settings.timezone,
      );
      if (start <= now) continue;
      const end = new Date(start.getTime() + duration * 60_000);
      if (overlaps(start, end, busy)) continue;
      slots.push(start);
    }
  }
  return slots;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** "24/09" and "14:30" in the account's timezone. */
export function formatDateTime(
  date: Date,
  timeZone: string,
): { date: string; time: string } {
  const p = localParts(date, timeZone);
  return { date: `${pad(p.day)}/${pad(p.month)}`, time: `${pad(p.hour)}:${pad(p.minute)}` };
}

/** Short label for a WhatsApp list row (≤ 24 chars): "ter 24/09 14:30". */
export function formatSlotLabel(date: Date, timeZone: string, locale = appLocaleTag()): string {
  const weekday = new Intl.DateTimeFormat(locale, { timeZone, weekday: 'short' })
    .format(date)
    .replace('.', '')
    .slice(0, 3);
  const { date: d, time } = formatDateTime(date, timeZone);
  return `${weekday} ${d} ${time}`;
}

export function renderReminder(
  template: string,
  values: { nome: string; data: string; hora: string },
): string {
  return template
    .replaceAll('{{nome}}', values.nome)
    .replaceAll('{{data}}', values.data)
    .replaceAll('{{hora}}', values.hora);
}

/** Row reply_id for an offered slot — the ISO start, parsed back on tap. */
export const SLOT_REPLY_PREFIX = 'slot:';

export function slotReplyId(start: Date): string {
  return `${SLOT_REPLY_PREFIX}${start.toISOString()}`;
}

export function parseSlotReplyId(replyId: string): Date | null {
  if (!replyId.startsWith(SLOT_REPLY_PREFIX)) return null;
  const d = new Date(replyId.slice(SLOT_REPLY_PREFIX.length));
  return Number.isNaN(d.getTime()) ? null : d;
}
