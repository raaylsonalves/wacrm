import type { SupabaseClient } from '@supabase/supabase-js';
import {
  DEFAULT_SETTINGS,
  isValidTimeZone,
  type AppointmentSettings,
  type BusyRange,
} from './slots';

/** Account business hours, falling back to defaults when never configured. */
export async function loadAppointmentSettings(
  db: SupabaseClient,
  accountId: string,
): Promise<AppointmentSettings> {
  const { data } = await db
    .from('appointment_settings')
    .select('*')
    .eq('account_id', accountId)
    .maybeSingle();
  return normalizeSettings(data as Partial<AppointmentSettings> | null);
}

/** Merge a stored row over defaults; an unusable timezone falls back to the default. */
export function normalizeSettings(row: Partial<AppointmentSettings> | null): AppointmentSettings {
  const merged = { ...DEFAULT_SETTINGS, ...(row ?? {}) };
  if (!isValidTimeZone(merged.timezone)) merged.timezone = DEFAULT_SETTINGS.timezone;
  return merged;
}

/**
 * A flow-configured agent id, kept only if that user is a member of the
 * account — flow config is caller-supplied (public API), and this runs
 * under the service role. Anything else books the shared calendar.
 */
export async function resolveAssignee(
  db: SupabaseClient,
  accountId: string,
  userId: string | null | undefined,
): Promise<string | null> {
  if (!userId) return null;
  const { data } = await db
    .from('profiles')
    .select('id')
    .eq('id', userId)
    .eq('account_id', accountId)
    .maybeSingle();
  return data ? userId : null;
}

/**
 * Busy ranges on one calendar: a specific agent's, or the shared one
 * when `assignedTo` is null — the same partition the
 * appointments_no_overlap constraint uses.
 */
export async function loadBusyRanges(
  db: SupabaseClient,
  accountId: string,
  assignedTo: string | null,
  from: Date,
  to: Date,
): Promise<BusyRange[]> {
  let query = db
    .from('appointments')
    .select('starts_at, ends_at')
    .eq('account_id', accountId)
    .neq('status', 'cancelled')
    .lt('starts_at', to.toISOString())
    .gt('ends_at', from.toISOString());
  query = assignedTo ? query.eq('assigned_to', assignedTo) : query.is('assigned_to', null);
  const { data } = await query;
  return ((data as { starts_at: string; ends_at: string }[] | null) ?? []).map((r) => ({
    start: new Date(r.starts_at),
    end: new Date(r.ends_at),
  }));
}

/** The conversation a reminder should go to: the booking's own, else the contact's latest. */
export async function resolveConversationId(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
  conversationId: string | null,
): Promise<string | null> {
  if (conversationId) return conversationId;
  const { data } = await db
    .from('conversations')
    .select('id')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .order('last_message_at', { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();
  return (data as { id: string } | null)?.id ?? null;
}
