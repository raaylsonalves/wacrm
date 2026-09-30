import crypto from 'crypto';
import { zonedToUtc } from '@/lib/appointments/slots';

/**
 * Pure helpers for the Google Calendar sync (specs/google-calendar-sync.md,
 * migration 096). No I/O here, so every rule the acceptance criteria name
 * — idempotent event ids, busy-block projection, backoff, signed state —
 * is unit-tested.
 */

/** httpOnly cookie carrying `<nonce>.<pkce verifier>` during the OAuth hop. */
export const PKCE_COOKIE = 'gcal_oauth';

export const GOOGLE_SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/calendar.events',
];

/** The window the pull re-reads each time. */
export const PULL_PAST_MS = 24 * 60 * 60 * 1000;
export const PULL_FUTURE_MS = 60 * 24 * 60 * 60 * 1000;

/**
 * Deterministic Google event id for an appointment. Google accepts
 * base32hex (0-9, a-v), 5–1024 chars; lowercase hex is a subset. A retried
 * create for the same appointment then gets 409 instead of a duplicate.
 */
export function googleEventId(appointmentId: string): string {
  return crypto
    .createHash('sha1')
    .update(`wacrm:${appointmentId}`)
    .digest('hex');
}

// ------------------------------------------------------------
// Push: appointment → event body
// ------------------------------------------------------------

export interface AppointmentForEvent {
  id: string;
  title: string;
  notes: string | null;
  starts_at: string;
  ends_at: string;
  status: string;
  contact: { name: string | null; phone: string | null } | null;
}

export function buildEventBody(
  a: AppointmentForEvent,
  opts: { timeZone: string; includePhone: boolean; appUrl: string | null }
): Record<string, unknown> {
  const who = a.contact?.name?.trim() || a.contact?.phone || '';
  const summary =
    who && !a.title.includes(who) ? `${a.title} — ${who}` : a.title;
  const lines: string[] = [];
  if (a.notes?.trim()) lines.push(a.notes.trim());
  if (opts.includePhone && a.contact?.phone)
    lines.push(`WhatsApp: ${a.contact.phone}`);
  if (opts.appUrl)
    lines.push(`Agenda: ${opts.appUrl.replace(/\/+$/, '')}/agenda`);
  return {
    id: googleEventId(a.id),
    summary,
    description: lines.join('\n') || undefined,
    start: { dateTime: a.starts_at, timeZone: opts.timeZone },
    end: { dateTime: a.ends_at, timeZone: opts.timeZone },
    status: a.status === 'cancelled' ? 'cancelled' : 'confirmed',
    extendedProperties: { private: { wacrmAppointmentId: a.id } },
  };
}

// ------------------------------------------------------------
// Pull: Google events → busy blocks
// ------------------------------------------------------------

export interface GoogleEventLite {
  id: string;
  status?: string;
  transparency?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  attendees?: { self?: boolean; responseStatus?: string }[];
  extendedProperties?: { private?: Record<string, string> };
}

export interface BusyBlock {
  google_event_id: string;
  starts_at: string;
  ends_at: string;
  all_day: boolean;
}

function dateToUtc(date: string, timeZone: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return null;
  return zonedToUtc(Number(m[1]), Number(m[2]), Number(m[3]), 0, 0, timeZone);
}

/**
 * Which events block time: not ours (our own bookings are already in the
 * appointments table), not cancelled, not marked "free", not declined by
 * the calendar owner. All-day events block whole days in the account's
 * timezone (Google's end date is exclusive).
 */
export function busyBlocksFromEvents(
  events: GoogleEventLite[],
  timeZone: string
): BusyBlock[] {
  const out: BusyBlock[] = [];
  for (const e of events) {
    if (!e.id) continue;
    if (e.extendedProperties?.private?.wacrmAppointmentId) continue;
    if (e.status === 'cancelled') continue;
    if (e.transparency === 'transparent') continue;
    if (e.attendees?.some((x) => x.self && x.responseStatus === 'declined'))
      continue;

    let start: Date | null = null;
    let end: Date | null = null;
    let allDay = false;
    if (e.start?.dateTime && e.end?.dateTime) {
      start = new Date(e.start.dateTime);
      end = new Date(e.end.dateTime);
    } else if (e.start?.date && e.end?.date) {
      start = dateToUtc(e.start.date, timeZone);
      end = dateToUtc(e.end.date, timeZone);
      allDay = true;
    }
    if (
      !start ||
      !end ||
      Number.isNaN(start.getTime()) ||
      Number.isNaN(end.getTime())
    )
      continue;
    if (end <= start) continue;
    out.push({
      google_event_id: e.id,
      starts_at: start.toISOString(),
      ends_at: end.toISOString(),
      all_day: allDay,
    });
  }
  return out;
}

// ------------------------------------------------------------
// Retry policy
// ------------------------------------------------------------

export const MAX_ATTEMPTS = 8;

/** Delay before the next attempt: Retry-After when Google sends one,
 *  else exponential from 1 min, capped at 1 h. */
export function backoffMs(
  attempts: number,
  retryAfter: string | null,
  now = Date.now()
): number {
  if (retryAfter) {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs) && secs >= 0)
      return Math.min(secs * 1000, 3_600_000);
    const at = Date.parse(retryAfter);
    if (Number.isFinite(at)) return Math.max(0, Math.min(at - now, 3_600_000));
  }
  return Math.min(60_000 * 2 ** Math.max(0, attempts), 3_600_000);
}

/** 5xx and 429 are worth retrying; other 4xx are permanent. */
export function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

export { connectionFor, type ConnectionRef } from './routing';

// ------------------------------------------------------------
// OAuth state: signed, expiring, account-bound
// ------------------------------------------------------------

export interface OAuthState {
  accountId: string;
  userId: string;
  nonce: string;
  exp: number;
}

function stateKey(secret: string): Buffer {
  return crypto
    .createHash('sha256')
    .update(`google-oauth-state:${secret}`)
    .digest();
}

export function signState(s: OAuthState, secret: string): string {
  const body = Buffer.from(JSON.stringify(s)).toString('base64url');
  const mac = crypto
    .createHmac('sha256', stateKey(secret))
    .update(body)
    .digest('base64url');
  return `${body}.${mac}`;
}

export function verifyState(
  token: string,
  secret: string,
  now = Date.now()
): OAuthState | null {
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;
  const expected = crypto
    .createHmac('sha256', stateKey(secret))
    .update(body)
    .digest();
  const given = Buffer.from(mac, 'base64url');
  if (
    given.length !== expected.length ||
    !crypto.timingSafeEqual(given, expected)
  )
    return null;
  try {
    const s = JSON.parse(
      Buffer.from(body, 'base64url').toString()
    ) as OAuthState;
    if (typeof s.exp !== 'number' || s.exp < now) return null;
    if (!s.accountId || !s.userId || !s.nonce) return null;
    return s;
  } catch {
    return null;
  }
}

/** PKCE S256 challenge for a verifier. */
export function pkceChallenge(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}
