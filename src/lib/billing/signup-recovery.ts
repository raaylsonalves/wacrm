// Abandoned sign-up recovery: an account that signed up and never paid
// (subscription_status 'pending') gets a nudge after an hour (e-mail +
// WhatsApp template) and a second one a day later (e-mail only). Seen on
// a competitor's checkout (specs/market-research-2026-10.md, 1.1): the
// lead is already captured, a short message wins some of them back.
//
// Runs from the automations cron. Sends go through notifyBilling, whose
// billing_notifications row makes each stage go out once per account.
// Never throws.

import type { SupabaseClient } from '@supabase/supabase-js';
import { notifyBilling } from './notify';

export const FIRST_NUDGE_MS = 60 * 60_000;
export const SECOND_NUDGE_MS = 24 * 60 * 60_000;
/** Older sign-ups are left alone — a nudge a month later is just spam. */
export const GIVE_UP_MS = 7 * 24 * 60 * 60_000;

/** Pure: which nudge is due for an account created at `createdAt`. */
export function recoveryStageFor(createdAt: Date, now: Date): 1 | 2 | null {
  const age = now.getTime() - createdAt.getTime();
  if (age < FIRST_NUDGE_MS || age > GIVE_UP_MS) return null;
  return age >= SECOND_NUDGE_MS ? 2 : 1;
}

export async function runSignupRecovery(
  db: SupabaseClient,
  now = new Date()
): Promise<{ checked: number; nudged: number }> {
  let checked = 0;
  let nudged = 0;
  try {
    const { data, error } = await db
      .from('accounts')
      .select('id, created_at')
      .eq('subscription_status', 'pending')
      .gte('created_at', new Date(now.getTime() - GIVE_UP_MS).toISOString())
      .lte('created_at', new Date(now.getTime() - FIRST_NUDGE_MS).toISOString())
      .limit(200);
    if (error) throw error;
    for (const row of data ?? []) {
      checked++;
      const stage = recoveryStageFor(new Date(row.created_at as string), now);
      if (!stage) continue;
      // Stage 2 also implies stage 1 was due; if the first never went out
      // (deploy landed mid-window), send only the current one.
      await notifyBilling(
        db,
        row.id as string,
        { kind: 'signup_incomplete', stage },
        `signup_incomplete:${stage}`
      );
      nudged++;
    }
  } catch (err) {
    console.error('[billing/signup-recovery] failed:', err);
  }
  return { checked, nudged };
}
