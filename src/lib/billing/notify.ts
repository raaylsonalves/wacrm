// One billing event -> the owner's e-mail and WhatsApp notice. Both are
// best-effort and never throw (see email/billing.ts, whatsapp-notify.ts).

import type { SupabaseClient } from '@supabase/supabase-js';
import { sendBillingEmail, type BillingEmail } from '@/lib/email/billing';
import { sendBillingWhatsApp } from './whatsapp-notify';

export async function notifyBilling(
  db: SupabaseClient,
  accountId: string,
  event: BillingEmail,
  idempotencyKey: string
): Promise<void> {
  await Promise.all([
    sendBillingEmail(db, accountId, event, idempotencyKey),
    sendBillingWhatsApp(db, accountId, event),
  ]);
}
