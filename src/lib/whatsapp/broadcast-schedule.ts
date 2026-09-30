// ============================================================
// Scheduled broadcasts (specs/scheduled-broadcasts.md).
//
// The wizard creates a 'scheduled' broadcast with its recipients already
// resolved and frozen; the cron sends it once `scheduled_at` passes.
// Sending reuses the Resume machinery (planBroadcastResume +
// deliverBroadcast) — one fan-out loop for immediate, resumed and
// scheduled sends alike. Opt-outs are re-checked at fire time, because an
// audience frozen days ago is stale on opt-outs.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  BroadcastError,
  deliverBroadcast,
  finalizeBroadcastStatus,
} from '@/lib/whatsapp/broadcast-core';
import {
  claimBroadcastDelivery,
  planBroadcastResume,
  releaseBroadcastDelivery,
} from '@/lib/whatsapp/broadcast-resume';
import {
  optedOutRecipientIds,
  type PendingRow,
} from './broadcast-schedule-rules';

export {
  canCancelBroadcast,
  optedOutRecipientIds,
  validScheduleTime,
} from './broadcast-schedule-rules';

/** Broadcasts picked per cron tick — each can take a while to send. */
export const SCHEDULE_BATCH = 5;

export interface ScheduleRunResult {
  started: number;
  finished: number;
  continued: number;
  failed: number;
}

/** Cron: send every scheduled broadcast whose time has come. Never throws. */
export async function runScheduledBroadcasts(
  db: SupabaseClient,
  now: Date = new Date()
): Promise<ScheduleRunResult> {
  const result: ScheduleRunResult = {
    started: 0,
    finished: 0,
    continued: 0,
    failed: 0,
  };
  try {
    const { data: due } = await db
      .from('broadcasts')
      .select('id, account_id')
      .eq('status', 'scheduled')
      .lte('scheduled_at', now.toISOString())
      .order('scheduled_at', { ascending: true })
      .limit(SCHEDULE_BATCH);

    for (const b of (due ?? []) as { id: string; account_id: string }[]) {
      // Claim: only one cron run moves it out of 'scheduled'.
      const { data: claimed } = await db
        .from('broadcasts')
        .update({ status: 'sending', updated_at: now.toISOString() })
        .eq('id', b.id)
        .eq('status', 'scheduled')
        .select('id');
      if (!claimed || claimed.length === 0) continue;
      if (!(await claimBroadcastDelivery(db, b.account_id, b.id, now)))
        continue;
      result.started++;

      try {
        const { data: pending } = await db
          .from('broadcast_recipients')
          .select('id, contact:contacts(opted_out_at)')
          .eq('broadcast_id', b.id)
          .eq('status', 'pending');
        const optedOut = optedOutRecipientIds((pending ?? []) as PendingRow[]);
        if (optedOut.length > 0) {
          await db
            .from('broadcast_recipients')
            .update({ status: 'failed', error_message: 'Contact opted out' })
            .in('id', optedOut);
        }

        const { plan, remaining } = await planBroadcastResume(
          db,
          b.account_id,
          b.id,
          'pending'
        );
        await deliverBroadcast(db, plan);
        if (remaining > 0) {
          // Bigger than one pass: hand it back to the next tick.
          await db
            .from('broadcasts')
            .update({ status: 'scheduled' })
            .eq('id', b.id);
          result.continued++;
        } else {
          await finalizeBroadcastStatus(db, b.id);
          result.finished++;
        }
      } catch (err) {
        if (err instanceof BroadcastError && err.code === 'nothing_to_resume') {
          // Everyone opted out or had no phone — close it out.
          await finalizeBroadcastStatus(db, b.id);
          result.finished++;
        } else {
          console.error(
            '[broadcast-schedule] send failed:',
            err instanceof Error ? err.message : err
          );
          await db
            .from('broadcasts')
            .update({ status: 'failed' })
            .eq('id', b.id);
          result.failed++;
        }
      } finally {
        await releaseBroadcastDelivery(db, b.id);
      }
    }
  } catch (err) {
    console.error(
      '[broadcast-schedule] run failed:',
      err instanceof Error ? err.message : err
    );
  }
  return result;
}
