// Which official (Meta Cloud API) number a send goes out through —
// specs/multi-official-numbers.md, stage 2.
//
// An account can have several official numbers (migration 112). A
// conversation records the one the customer last wrote to
// (`conversations.whatsapp_config_id`, stamped by the webhook), and a
// reply must leave through that same number — otherwise the customer gets
// the answer from a different WhatsApp than the one they messaged.
// Without a conversation (or for one not tied to a number yet) the
// account's primary number is used, which is exactly the single-number
// behaviour from before.

import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * The whatsapp_config row to send through: the conversation's number when
 * it has one (and it still belongs to this account), else the primary.
 * Null when the account has no official number at all.
 */
export async function loadOfficialNumber(
  // Any Supabase client: service role (engines) or the caller's session.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: SupabaseClient<any, any, any>,
  accountId: string,
  conversationId?: string | null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<Record<string, any> | null> {
  if (conversationId) {
    const { data: conv } = await db
      .from('conversations')
      .select('whatsapp_config_id')
      .eq('id', conversationId)
      .eq('account_id', accountId)
      .maybeSingle();
    const configId = conv?.whatsapp_config_id as string | null | undefined;
    if (configId) {
      // Scoped by account too: a stale id must never send through
      // another tenant's number.
      const { data: own } = await db
        .from('whatsapp_config')
        .select('*')
        .eq('id', configId)
        .eq('account_id', accountId)
        .maybeSingle();
      if (own) return own;
    }
  }
  const { data: primary } = await db
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', accountId)
    .eq('is_primary', true)
    .maybeSingle();
  return primary ?? null;
}
