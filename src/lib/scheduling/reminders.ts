// Reminders for bookings made in a partner system (ScaLE, migration 141):
// "your time is at 13h30 with Souzza" a while before it starts, sent once
// on the booking's own conversation. Swept by GET /api/automations/cron.
// Never throws.

import type { SupabaseClient } from '@supabase/supabase-js';
import { engineSendText } from '@/lib/flows/meta-send';

/** The shop's wall clock now, "YYYY-MM-DDTHH:MM:SS" (the partner's format). */
export function localNow(timeZone: string, now: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}`;
}

const wall = (s: string) => Date.parse(`${s.slice(0, 19)}Z`);

/** Due: inside the `minutes` before the start, and not started yet. */
export function reminderDue(
  startsLocal: string,
  nowLocal: string,
  minutes: number
): boolean {
  const start = wall(startsLocal);
  const now = wall(nowLocal);
  return now < start && start - now <= minutes * 60_000;
}

export function reminderText(
  template: string,
  b: {
    name: string | null;
    startsLocal: string;
    professional: string | null;
    code: string | null;
  }
): string {
  const [date, time] = b.startsLocal.split('T');
  const [, mm, dd] = date.split('-');
  const [h, m] = time.split(':');
  const first = (b.name ?? '').trim().split(/\s+/)[0] ?? '';
  return template
    .replaceAll('{nome}', first)
    .replaceAll('{data}', `${dd}/${mm}`)
    .replaceAll('{hora}', m === '00' ? `${Number(h)}h` : `${Number(h)}h${m}`)
    .replaceAll('{barbeiro}', b.professional ?? '')
    .replaceAll('{codigo}', b.code ?? '')
    .replace(/\s+([!?.,])/g, '$1')
    .replace(/ {2,}/g, ' ')
    .trim();
}

export async function sweepBookingReminders(
  db: SupabaseClient,
  now: Date = new Date()
): Promise<number> {
  let sent = 0;
  try {
    const { data: integrations } = await db
      .from('scheduling_integrations')
      .select(
        'account_id, reminder_minutes, reminder_text, timezone, created_by'
      )
      .eq('enabled', true)
      .not('reminder_minutes', 'is', null)
      .not('reminder_text', 'is', null);
    for (const integ of integrations ?? []) {
      const minutes = integ.reminder_minutes as number;
      const nowLocal = localNow(integ.timezone as string, now);
      const horizon = localNow(
        integ.timezone as string,
        new Date(now.getTime() + minutes * 60_000)
      );
      const { data: bookings } = await db
        .from('external_bookings')
        .select(
          'id, conversation_id, contact_id, starts_local, professional_name, code, status, contact:contacts(name)'
        )
        .eq('account_id', integ.account_id)
        .is('reminded_at', null)
        .not('conversation_id', 'is', null)
        .gt('starts_local', nowLocal)
        .lte('starts_local', horizon)
        .limit(100);
      for (const b of bookings ?? []) {
        if (/cancel/i.test(String(b.status ?? ''))) continue;
        const startsLocal = String(b.starts_local);
        if (!reminderDue(startsLocal, nowLocal, minutes)) continue;
        // Claim first: an overlapping tick must not send it twice.
        const { data: claimed } = await db
          .from('external_bookings')
          .update({ reminded_at: now.toISOString() })
          .eq('id', b.id)
          .is('reminded_at', null)
          .select('id');
        if (!claimed?.length) continue;
        const contact = b.contact as { name?: string | null } | null;
        try {
          await engineSendText({
            accountId: integ.account_id as string,
            userId: integ.created_by as string,
            conversationId: b.conversation_id as string,
            contactId: b.contact_id as string,
            text: reminderText(integ.reminder_text as string, {
              name: contact?.name ?? null,
              startsLocal,
              professional: b.professional_name as string | null,
              code: b.code as string | null,
            }),
          });
          sent++;
        } catch (err) {
          console.error('[booking reminder] send failed:', b.id, err);
        }
      }
    }
  } catch (err) {
    console.error('[booking reminder] sweep failed:', err);
  }
  return sent;
}
