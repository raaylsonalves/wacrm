import type { SupabaseClient } from '@supabase/supabase-js';
import { loadAppointmentSettings } from '@/lib/appointments/store';
import {
  accessTokenFor,
  deleteEvent,
  googleCalendarEnabled,
  GoogleApiError,
  listEvents,
  upsertEvent,
} from './google-api';
import {
  backoffMs,
  buildEventBody,
  busyBlocksFromEvents,
  connectionFor,
  googleEventId,
  isRetryable,
  MAX_ATTEMPTS,
  PULL_FUTURE_MS,
  PULL_PAST_MS,
  type AppointmentForEvent,
  type GoogleEventLite,
} from './logic';

/**
 * The Google Calendar worker, run from GET /api/automations/cron (no second
 * pinger). Push drains `calendar_sync_outbox` (filled by the appointments
 * trigger, migration 096); pull re-reads each connection's window and
 * replaces its busy blocks. Never throws: Google being down must never
 * fail or delay a booking — the outbox just waits.
 */

const OUTBOX_BATCH = 50;
const PULL_BATCH = 20;
const PULL_EVERY_MS = 4 * 60 * 1000;

interface Connection {
  id: string;
  account_id: string;
  user_id: string | null;
  status: string;
  google_calendar_id: string;
  refresh_token_enc: string;
  include_customer_phone: boolean;
  last_synced_at: string | null;
}

export interface CalendarSyncResult {
  pushed: number;
  failed: number;
  pulled: number;
}

export async function runCalendarSync(
  db: SupabaseClient,
  now = new Date()
): Promise<CalendarSyncResult | null> {
  if (!googleCalendarEnabled()) return null;
  const result: CalendarSyncResult = { pushed: 0, failed: 0, pulled: 0 };
  const tokens = new Map<string, Promise<string>>();
  try {
    await drainOutbox(db, now, tokens, result);
  } catch (err) {
    console.error('[google-calendar] push failed:', err);
  }
  try {
    await pullBusyBlocks(db, now, tokens, result);
  } catch (err) {
    console.error('[google-calendar] pull failed:', err);
  }
  return result;
}

function tokenFor(
  conn: Connection,
  cache: Map<string, Promise<string>>
): Promise<string> {
  let p = cache.get(conn.id);
  if (!p) {
    p = accessTokenFor(conn.refresh_token_enc);
    cache.set(conn.id, p);
  }
  return p;
}

/** A refresh token Google no longer accepts: pause, keep everything. */
async function markReauth(
  db: SupabaseClient,
  conn: Connection,
  err: unknown
): Promise<boolean> {
  if (
    err instanceof GoogleApiError &&
    (err.code === 'invalid_grant' || err.status === 401)
  ) {
    await db
      .from('calendar_connections')
      .update({
        status: 'needs_reauth',
        last_error: 'Autorização do Google expirou ou foi revogada.',
      })
      .eq('id', conn.id);
    return true;
  }
  return false;
}

async function loadConnections(
  db: SupabaseClient,
  accountId: string
): Promise<Connection[]> {
  const { data } = await db
    .from('calendar_connections')
    .select(
      'id, account_id, user_id, status, google_calendar_id, refresh_token_enc, include_customer_phone, last_synced_at'
    )
    .eq('account_id', accountId);
  return (data as Connection[] | null) ?? [];
}

// ------------------------------------------------------------
// Push
// ------------------------------------------------------------

interface OutboxRow {
  id: number;
  account_id: string;
  appointment_id: string;
  op: 'upsert' | 'delete';
  attempts: number;
  next_attempt_at: string;
}

async function drainOutbox(
  db: SupabaseClient,
  now: Date,
  tokens: Map<string, Promise<string>>,
  result: CalendarSyncResult
): Promise<void> {
  const { data } = await db
    .from('calendar_sync_outbox')
    .select('id, account_id, appointment_id, op, attempts, next_attempt_at')
    .lte('next_attempt_at', now.toISOString())
    .order('next_attempt_at', { ascending: true })
    .limit(OUTBOX_BATCH);
  const rows = (data as OutboxRow[] | null) ?? [];
  const connCache = new Map<string, Connection[]>();

  for (const row of rows) {
    let conns = connCache.get(row.account_id);
    if (!conns) {
      conns = await loadConnections(db, row.account_id);
      connCache.set(row.account_id, conns);
    }
    // Done = remove the row, unless the trigger re-queued it meanwhile
    // (it resets next_attempt_at), in which case the newer request stays.
    const done = () =>
      db
        .from('calendar_sync_outbox')
        .delete()
        .eq('id', row.id)
        .eq('next_attempt_at', row.next_attempt_at);

    let conn: Connection | null = null;
    try {
      const { data: mapping } = await db
        .from('appointment_google_events')
        .select('connection_id, google_event_id')
        .eq('appointment_id', row.appointment_id)
        .maybeSingle();
      const mapped = mapping
        ? (conns.find((c) => c.id === mapping.connection_id) ?? null)
        : null;

      if (row.op === 'delete') {
        if (mapped && mapped.status === 'active') {
          conn = mapped;
          await deleteEvent(
            await tokenFor(mapped, tokens),
            mapped.google_calendar_id,
            mapping!.google_event_id
          );
        }
        await db
          .from('appointment_google_events')
          .delete()
          .eq('appointment_id', row.appointment_id);
        await done();
        result.pushed++;
        continue;
      }

      const { data: appt } = await db
        .from('appointments')
        .select(
          'id, account_id, assigned_to, title, notes, starts_at, ends_at, status, contact:contacts(name, phone)'
        )
        .eq('id', row.appointment_id)
        .eq('account_id', row.account_id)
        .maybeSingle();
      if (!appt) {
        await done(); // deleted meanwhile; its delete row follows
        continue;
      }
      conn = connectionFor(conns, (appt.assigned_to as string | null) ?? null);
      if (!conn) {
        await done(); // no calendar for this booking: simply not synced
        continue;
      }
      // Reassigned to someone with another calendar: remove the old copy.
      if (mapped && mapped.id !== conn.id && mapped.status === 'active') {
        await deleteEvent(
          await tokenFor(mapped, tokens),
          mapped.google_calendar_id,
          mapping!.google_event_id
        );
      }
      const settings = await loadAppointmentSettings(db, row.account_id);
      const body = buildEventBody(appt as unknown as AppointmentForEvent, {
        timeZone: settings.timezone,
        includePhone: conn.include_customer_phone,
        appUrl: process.env.NEXT_PUBLIC_SITE_URL?.trim() || null,
      });
      await upsertEvent(
        await tokenFor(conn, tokens),
        conn.google_calendar_id,
        body
      );
      await db.from('appointment_google_events').upsert({
        appointment_id: row.appointment_id,
        account_id: row.account_id,
        connection_id: conn.id,
        google_event_id: googleEventId(row.appointment_id),
        synced_at: new Date().toISOString(),
        last_error: null,
      });
      await done();
      result.pushed++;
    } catch (err) {
      result.failed++;
      const message =
        err instanceof Error ? err.message.slice(0, 300) : 'unknown error';
      if (conn && (await markReauth(db, conn, err))) {
        conn.status = 'needs_reauth';
        // Keep the row; it resumes after the owner reconnects.
        await db
          .from('calendar_sync_outbox')
          .update({
            next_attempt_at: new Date(now.getTime() + 3_600_000).toISOString(),
            last_error: message,
          })
          .eq('id', row.id);
        continue;
      }
      const retry = !(err instanceof GoogleApiError) || isRetryable(err.status);
      if (retry && row.attempts + 1 < MAX_ATTEMPTS) {
        const wait = backoffMs(
          row.attempts,
          err instanceof GoogleApiError ? err.retryAfter : null,
          now.getTime()
        );
        await db
          .from('calendar_sync_outbox')
          .update({
            attempts: row.attempts + 1,
            next_attempt_at: new Date(now.getTime() + wait).toISOString(),
            last_error: message,
          })
          .eq('id', row.id);
      } else {
        // Permanent: record it where the UI can show it, stop retrying.
        if (conn) {
          await db.from('appointment_google_events').upsert({
            appointment_id: row.appointment_id,
            account_id: row.account_id,
            connection_id: conn.id,
            google_event_id: googleEventId(row.appointment_id),
            last_error: message,
          });
        }
        await db.from('calendar_sync_outbox').delete().eq('id', row.id);
      }
      console.warn(
        '[google-calendar] push failed for appointment',
        row.appointment_id,
        message
      );
    }
  }
}

// ------------------------------------------------------------
// Pull
// ------------------------------------------------------------

async function pullBusyBlocks(
  db: SupabaseClient,
  now: Date,
  tokens: Map<string, Promise<string>>,
  result: CalendarSyncResult
): Promise<void> {
  const staleBefore = new Date(now.getTime() - PULL_EVERY_MS).toISOString();
  const { data } = await db
    .from('calendar_connections')
    .select(
      'id, account_id, user_id, status, google_calendar_id, refresh_token_enc, include_customer_phone, last_synced_at'
    )
    .eq('status', 'active')
    .or(`last_synced_at.is.null,last_synced_at.lt.${staleBefore}`)
    .order('last_synced_at', { ascending: true, nullsFirst: true })
    .limit(PULL_BATCH);

  for (const conn of (data as Connection[] | null) ?? []) {
    const from = new Date(now.getTime() - PULL_PAST_MS);
    const to = new Date(now.getTime() + PULL_FUTURE_MS);
    try {
      const events = (await listEvents(
        await tokenFor(conn, tokens),
        conn.google_calendar_id,
        from,
        to
      )) as GoogleEventLite[];
      const settings = await loadAppointmentSettings(db, conn.account_id);
      const blocks = busyBlocksFromEvents(events, settings.timezone);

      // Replace this connection's blocks inside the window.
      await db
        .from('calendar_busy_blocks')
        .delete()
        .eq('connection_id', conn.id)
        .lt('starts_at', to.toISOString())
        .gt('ends_at', from.toISOString());
      if (blocks.length > 0) {
        await db
          .from('calendar_busy_blocks')
          .upsert(
            blocks.map((b) => ({
              ...b,
              connection_id: conn.id,
              account_id: conn.account_id,
            }))
          );
      }
      // Anything that ended long ago is no longer useful.
      await db
        .from('calendar_busy_blocks')
        .delete()
        .eq('connection_id', conn.id)
        .lt('ends_at', from.toISOString());
      await db
        .from('calendar_connections')
        .update({ last_synced_at: now.toISOString(), last_error: null })
        .eq('id', conn.id);
      result.pulled++;
    } catch (err) {
      if (await markReauth(db, conn, err)) continue;
      const message =
        err instanceof Error ? err.message.slice(0, 300) : 'unknown error';
      await db
        .from('calendar_connections')
        .update({ last_synced_at: now.toISOString(), last_error: message })
        .eq('id', conn.id);
      console.warn(
        '[google-calendar] pull failed for connection',
        conn.id,
        message
      );
    }
  }
}

/**
 * Right after connecting: queue every upcoming booking so the calendar
 * starts complete, and pull the owner's busy time on the next tick.
 */
export async function backfillConnection(
  db: SupabaseClient,
  accountId: string
): Promise<number> {
  const { data } = await db
    .from('appointments')
    .select('id')
    .eq('account_id', accountId)
    .neq('status', 'cancelled')
    .gt('ends_at', new Date().toISOString())
    .limit(500);
  const rows = ((data as { id: string }[] | null) ?? []).map((a) => ({
    account_id: accountId,
    appointment_id: a.id,
    op: 'upsert' as const,
  }));
  if (rows.length === 0) return 0;
  await db
    .from('calendar_sync_outbox')
    .upsert(rows, { onConflict: 'appointment_id' });
  return rows.length;
}
