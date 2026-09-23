import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import { sendMessageToConversation } from '@/lib/whatsapp/send-message';
import {
  DEFAULT_SETTINGS,
  formatDateTime,
  renderReminder,
  type AppointmentSettings,
} from '@/lib/appointments/slots';
import { normalizeSettings, resolveConversationId } from '@/lib/appointments/store';

interface DueRow {
  id: string;
  account_id: string;
  contact_id: string;
  conversation_id: string | null;
  starts_at: string;
  contact: { name: string | null; phone: string | null } | null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- PostgREST filter builder generics
type DueQuery = any;

/**
 * Send WhatsApp reminders for upcoming appointments. Hit on a schedule
 * (external pinger, same as /api/automations/cron) with the shared
 * `AUTOMATION_CRON_SECRET`, as `x-cron-secret` or `Authorization: Bearer`.
 *
 * `reminder_sent_at` is claimed with a compare-and-swap before sending,
 * so overlapping runs never double-remind. A failed send (typically
 * Meta's 24h window — a reminder is free-form text, not a template) is
 * logged and not retried; the claim stays, by design.
 */
export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET;
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 });
  }
  const bearer = request.headers.get('authorization');
  const supplied =
    request.headers.get('x-cron-secret') ??
    (bearer?.startsWith('Bearer ') ? bearer.slice(7) : '');
  const suppliedBuf = Buffer.from(supplied);
  const expectedBuf = Buffer.from(expected);
  if (suppliedBuf.length !== expectedBuf.length || !timingSafeEqual(suppliedBuf, expectedBuf)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const admin = supabaseAdmin();
  const now = new Date();

  // Only ever fetch rows that are actually due, per reminder window —
  // skipped rows are never marked, so a page padded with not-yet-due or
  // reminders-off rows would starve every account behind it.
  const { data: rows, error: settingsError } = await admin
    .from('appointment_settings')
    .select('*');
  if (settingsError) {
    return NextResponse.json({ error: settingsError.message }, { status: 500 });
  }
  const settingsByAccount = new Map<string, AppointmentSettings>();
  for (const row of rows ?? []) {
    settingsByAccount.set(row.account_id as string, normalizeSettings(row));
  }
  const configured = [...settingsByAccount.keys()];

  // Group explicitly-configured accounts by their window; accounts that
  // never saved settings use the default window.
  const windows = new Map<number, string[]>();
  for (const [accountId, settings] of settingsByAccount) {
    if (!settings.reminder_enabled) continue;
    const ids = windows.get(settings.reminder_hours_before) ?? [];
    ids.push(accountId);
    windows.set(settings.reminder_hours_before, ids);
  }

  const due: DueRow[] = [];
  const fetchDue = async (hours: number, scope: (q: DueQuery) => DueQuery) => {
    const horizon = new Date(now.getTime() + hours * 3_600_000);
    const { data, error } = await scope(
      admin
        .from('appointments')
        .select('id, account_id, contact_id, conversation_id, starts_at, contact:contacts(name, phone)')
        .is('reminder_sent_at', null)
        .in('status', ['scheduled', 'confirmed'])
        .gt('starts_at', now.toISOString())
        .lte('starts_at', horizon.toISOString()),
    )
      .order('starts_at')
      .limit(100);
    if (error) throw new Error(error.message);
    due.push(...((data ?? []) as unknown as DueRow[]));
  };

  try {
    for (const [hours, ids] of windows) {
      await fetchDue(hours, (q) => q.in('account_id', ids));
    }
    if (DEFAULT_SETTINGS.reminder_enabled) {
      await fetchDue(DEFAULT_SETTINGS.reminder_hours_before, (q) =>
        configured.length > 0 ? q.not('account_id', 'in', `(${configured.join(',')})`) : q,
      );
    }
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }

  let sent = 0;
  let failed = 0;

  for (const row of due) {
    const settings = settingsByAccount.get(row.account_id) ?? DEFAULT_SETTINGS;

    const { data: claim } = await admin
      .from('appointments')
      .update({ reminder_sent_at: now.toISOString() })
      .eq('id', row.id)
      .is('reminder_sent_at', null)
      .select('id')
      .maybeSingle();
    if (!claim) continue;

    const conversationId = await resolveConversationId(
      admin,
      row.account_id,
      row.contact_id,
      row.conversation_id,
    );
    if (!conversationId) {
      failed++;
      continue;
    }

    const { date, time } = formatDateTime(new Date(row.starts_at), settings.timezone);
    try {
      await sendMessageToConversation(admin, row.account_id, {
        conversationId,
        messageType: 'text',
        contentText: renderReminder(settings.reminder_text, {
          nome: row.contact?.name?.split(' ')[0] ?? '',
          data: date,
          hora: time,
        }),
      });
      sent++;
    } catch (err) {
      failed++;
      console.error('[appointments/cron] reminder failed', row.id, err);
    }
  }

  return NextResponse.json({ sent, failed });
}
