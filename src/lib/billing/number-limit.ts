// How many WhatsApp numbers an account may connect (migration 116).
//
// Standard plans include ONE number — official (Meta) or own (QR / WAHA).
// More is a custom deal: the platform sets `accounts.max_whatsapp_numbers`
// in the Subscribers panel. Exempt accounts (the platform itself, clients
// an operator manages) are unlimited unless a limit was set explicitly.

import type { SupabaseClient } from '@supabase/supabase-js';

/** Numbers included in every standard plan. */
export const STANDARD_PLAN_NUMBERS = 1;

/** The account's limit; null = unlimited. Pure, for the rule's tests. */
export function numberLimitFor(account: {
  max_whatsapp_numbers: number | null;
  subscription_status: string | null;
}): number | null {
  if (account.max_whatsapp_numbers != null) return account.max_whatsapp_numbers;
  return account.subscription_status === 'exempt' ? null : STANDARD_PLAN_NUMBERS;
}

/**
 * Whether the account may connect ONE MORE number. Counts official numbers
 * and WAHA channels together. Reads with the service role so a caller's
 * RLS can never hide a number from the count.
 */
export async function canAddWhatsappNumber(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  admin: SupabaseClient<any, any, any>,
  accountId: string
): Promise<{ allowed: boolean; limit: number | null; used: number }> {
  const [{ data: account }, { count: official }, { count: waha }] =
    await Promise.all([
      admin
        .from('accounts')
        .select('max_whatsapp_numbers, subscription_status')
        .eq('id', accountId)
        .maybeSingle(),
      admin
        .from('whatsapp_config')
        .select('id', { count: 'exact', head: true })
        .eq('account_id', accountId),
      admin
        .from('whatsapp_waha_channels')
        .select('id', { count: 'exact', head: true })
        .eq('account_id', accountId),
    ]);
  const limit = numberLimitFor({
    max_whatsapp_numbers:
      (account?.max_whatsapp_numbers as number | null | undefined) ?? null,
    subscription_status:
      (account?.subscription_status as string | null | undefined) ?? null,
  });
  const used = (official ?? 0) + (waha ?? 0);
  return { allowed: limit === null || used < limit, limit, used };
}
