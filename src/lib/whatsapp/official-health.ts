// Periodic health check of official (Meta Cloud API) numbers
// (migration 120). Called from the cron hub.
//
// A number's `status` only changes when someone saves it, so a token that
// expired on its own (Meta's 24-hour test tokens, a revoked system user)
// stayed "connected" until a send failed. Every 30 minutes each number is
// asked about once; a failure is recorded in `health_error` — the inbox
// banner and the numbers list read it — and the account's admins are
// notified when a number STARTS failing (not on every tick).
//
// Never throws: one account's number must not stop the cron.

import type { SupabaseClient } from '@supabase/supabase-js';
import { verifyPhoneNumber } from './meta-api';
import { decrypt } from './encryption';
import { explainMetaError } from './meta-error-explain';
import { adminsFor, notifyUsers } from '@/lib/notifications/notify';

/** How often each number is checked. */
export const HEALTH_INTERVAL_MS = 30 * 60_000;
/** Numbers checked per tick, oldest check first. */
const BATCH = 25;

export interface HealthSummary {
  checked: number;
  failing: number;
  newlyFailing: number;
}

/** Whether a transition deserves a notification: only healthy -> failing. */
export function startsFailing(before: string | null, after: string | null): boolean {
  return !before && !!after;
}

export async function runOfficialNumberHealth(
  db: SupabaseClient,
  now: Date = new Date()
): Promise<HealthSummary> {
  const summary: HealthSummary = { checked: 0, failing: 0, newlyFailing: 0 };
  try {
    const due = new Date(now.getTime() - HEALTH_INTERVAL_MS).toISOString();
    const { data: rows, error } = await db
      .from('whatsapp_config')
      .select(
        'id, account_id, phone_number_id, waba_id, access_token, label, display_phone_number, health_error'
      )
      .or(`health_checked_at.is.null,health_checked_at.lt.${due}`)
      .order('health_checked_at', { ascending: true, nullsFirst: true })
      .limit(BATCH);
    if (error) {
      console.error('[official-health] scan failed:', error.message);
      return summary;
    }

    for (const row of rows ?? []) {
      summary.checked++;
      let failure: string | null = null;
      try {
        await verifyPhoneNumber({
          phoneNumberId: row.phone_number_id as string,
          accessToken: decrypt(row.access_token as string),
        });
      } catch (err) {
        failure = explainMetaError(err, 'verify_number', {
          phoneNumberId: row.phone_number_id as string,
          wabaId: (row.waba_id as string | null) ?? null,
        }).summary;
      }

      const before = (row.health_error as string | null) ?? null;
      await db
        .from('whatsapp_config')
        .update({
          health_error: failure,
          health_checked_at: now.toISOString(),
        })
        .eq('id', row.id);

      if (failure) summary.failing++;
      if (startsFailing(before, failure)) {
        summary.newlyFailing++;
        const admins = await adminsFor(db, row.account_id as string);
        await notifyUsers(db, {
          accountId: row.account_id as string,
          userIds: admins,
          type: 'channel_disconnected',
          data: {
            channel:
              (row.label as string | null) ||
              (row.display_phone_number as string | null) ||
              (row.phone_number_id as string),
          },
          body: failure,
          link: '/settings?tab=whatsapp',
          groupKey: `official-health:${row.id as string}`,
        });
      }
    }
  } catch (err) {
    console.error('[official-health] failed:', err);
  }
  return summary;
}
