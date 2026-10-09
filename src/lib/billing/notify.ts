// One billing event -> the owner's e-mail and WhatsApp notice, once.
//
// `billing_notifications` (migration 122) is the lock: the first caller to
// insert (account, key) sends; an overlapping cron or a redelivered webhook
// hits the primary key and sends nothing. Best-effort and never throws
// (see email/billing.ts, whatsapp-notify.ts).

import type { SupabaseClient } from '@supabase/supabase-js';
import { sendBillingEmail, type BillingEmail } from '@/lib/email/billing';
import { sendBillingWhatsApp } from './whatsapp-notify';

export async function notifyBilling(
  db: SupabaseClient,
  accountId: string,
  event: BillingEmail,
  key: string
): Promise<void> {
  try {
    const { error } = await db
      .from('billing_notifications')
      .insert({ account_id: accountId, key });
    if (error) {
      // Already sent by someone else: done. Any other error: still send —
      // a missed notice is worse than a rare duplicate.
      if (error.code === '23505') return;
      console.error('[billing/notify] could not record notice:', error.message);
    }
    await Promise.all([
      sendBillingEmail(db, accountId, event, key),
      sendBillingWhatsApp(db, accountId, event),
    ]);
  } catch (err) {
    console.error('[billing/notify] failed:', err);
  }
}
