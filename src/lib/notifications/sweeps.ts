// ============================================================
// Cron sweeps that turn "time passed" into a notification: a customer
// waiting past the account's response target, and an appointment about
// to start. Each stamps a marker on its row (`sla_notified_at`,
// `team_reminded_at`) so it fires once per episode. Never throws.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import { notifyUsers, teamForChannel, teamForConversation } from './notify';

/** Only look this far back — a first run must not page for last month. */
const SLA_LOOKBACK_MS = 12 * 60 * 60 * 1000;
export const REMINDER_LEAD_MS = 15 * 60 * 1000;

/** Minutes a customer has waited, or null if it's not an SLA breach yet. */
export function slaBreachMinutes(args: {
  lastCustomerMessageAt: string | null;
  notifiedAt: string | null;
  targetMinutes: number;
  now: number;
}): number | null {
  if (!args.lastCustomerMessageAt || args.targetMinutes <= 0) return null;
  const at = new Date(args.lastCustomerMessageAt).getTime();
  if (!Number.isFinite(at)) return null;
  const waited = args.now - at;
  if (waited < args.targetMinutes * 60_000 || waited > SLA_LOOKBACK_MS)
    return null;
  // Already alerted for this customer message.
  if (args.notifiedAt && new Date(args.notifiedAt).getTime() >= at) return null;
  return Math.floor(waited / 60_000);
}

export async function sweepSlaBreaches(db: SupabaseClient): Promise<number> {
  let sent = 0;
  try {
    const now = Date.now();
    const { data: rows } = await db
      .from('conversations')
      .select(
        'id, account_id, contact_id, last_message_text, last_customer_message_at, sla_notified_at, contact:contacts(name, phone), account:accounts(response_time_target_minutes)'
      )
      .neq('status', 'closed')
      .eq('last_message_sender_type', 'customer')
      .gte(
        'last_customer_message_at',
        new Date(now - SLA_LOOKBACK_MS).toISOString()
      )
      .limit(300);

    for (const r of (rows ?? []) as Record<string, unknown>[]) {
      const account = (Array.isArray(r.account) ? r.account[0] : r.account) as {
        response_time_target_minutes?: number | null;
      } | null;
      const minutes = slaBreachMinutes({
        lastCustomerMessageAt: r.last_customer_message_at as string | null,
        notifiedAt: r.sla_notified_at as string | null,
        targetMinutes: account?.response_time_target_minutes ?? 0,
        now,
      });
      if (minutes === null) continue;

      // Claim first so an overlapping cron run can't double-page.
      const { data: claimed } = await db
        .from('conversations')
        .update({ sla_notified_at: new Date(now).toISOString() })
        .eq('id', r.id as string)
        .or(
          `sla_notified_at.is.null,sla_notified_at.lt.${r.last_customer_message_at}`
        )
        .select('id');
      if (!claimed || claimed.length === 0) continue;

      const contact = (Array.isArray(r.contact) ? r.contact[0] : r.contact) as {
        name?: string | null;
        phone?: string | null;
      } | null;
      await notifyUsers(db, {
        accountId: r.account_id as string,
        userIds: await teamForConversation(
          db,
          r.account_id as string,
          r.id as string
        ),
        type: 'sla_breached',
        conversationId: r.id as string,
        contactId: r.contact_id as string,
        contactName: contact?.name || contact?.phone || null,
        body:
          ((r.last_message_text as string | null) ?? '').slice(0, 200) || null,
        data: { minutes },
        link: `/inbox?c=${r.id}`,
        groupKey: `sla:${r.id}`,
      });
      sent++;
    }
  } catch (err) {
    console.warn(
      '[notify] SLA sweep failed:',
      err instanceof Error ? err.message : err
    );
  }
  return sent;
}

/** "14:30" in the agenda's timezone. */
export function formatTimeIn(iso: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('pt-BR', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone,
    }).format(new Date(iso));
  } catch {
    return new Date(iso).toISOString().slice(11, 16);
  }
}

export async function sweepAppointmentReminders(
  db: SupabaseClient
): Promise<number> {
  let sent = 0;
  try {
    const now = Date.now();
    const { data: rows } = await db
      .from('appointments')
      .select(
        'id, account_id, contact_id, conversation_id, title, starts_at, assigned_to, created_by, contact:contacts(name, phone)'
      )
      .in('status', ['scheduled', 'confirmed'])
      .is('team_reminded_at', null)
      .gte('starts_at', new Date(now).toISOString())
      .lte('starts_at', new Date(now + REMINDER_LEAD_MS).toISOString())
      .limit(200);

    const tzCache = new Map<string, string>();
    for (const r of (rows ?? []) as Record<string, unknown>[]) {
      const { data: claimed } = await db
        .from('appointments')
        .update({ team_reminded_at: new Date(now).toISOString() })
        .eq('id', r.id as string)
        .is('team_reminded_at', null)
        .select('id');
      if (!claimed || claimed.length === 0) continue;

      const accountId = r.account_id as string;
      if (!tzCache.has(accountId)) {
        const { data: s } = await db
          .from('appointment_settings')
          .select('timezone')
          .eq('account_id', accountId)
          .maybeSingle();
        tzCache.set(
          accountId,
          (s?.timezone as string | undefined) ?? 'America/Sao_Paulo'
        );
      }
      const owner =
        (r.assigned_to as string | null) ?? (r.created_by as string | null);
      const contact = (Array.isArray(r.contact) ? r.contact[0] : r.contact) as {
        name?: string | null;
        phone?: string | null;
      } | null;
      await notifyUsers(db, {
        accountId,
        userIds: owner ? [owner] : await teamForChannel(db, accountId, null),
        type: 'appointment_reminder',
        conversationId: (r.conversation_id as string | null) ?? null,
        contactId: (r.contact_id as string | null) ?? null,
        contactName: contact?.name || contact?.phone || null,
        data: {
          title: r.title,
          time: formatTimeIn(r.starts_at as string, tzCache.get(accountId)!),
        },
        link: r.conversation_id ? `/inbox?c=${r.conversation_id}` : '/agenda',
      });
      sent++;
    }
  } catch (err) {
    console.warn(
      '[notify] reminder sweep failed:',
      err instanceof Error ? err.message : err
    );
  }
  return sent;
}
