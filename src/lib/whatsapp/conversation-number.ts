// One conversation per (contact, number) — specs/multi-official-numbers.md,
// stage 2b (migration 114). The same customer writing to reception and to
// sales has two threads. A conversation's number is its WAHA channel
// (`whatsapp_channel_id`) when set, else its official number
// (`whatsapp_config_id`).
//
// Every find-or-create of a conversation goes through here so the
// webhooks, sends, broadcasts and prospecting agree on which thread a
// message belongs to.

import type { SupabaseClient } from '@supabase/supabase-js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = SupabaseClient<any, any, any>;

/** Which number: a WAHA channel, or an official number (or neither). */
export interface ConversationNumber {
  channelId: string | null;
  configId: string | null;
}

/** The account's primary official number, or null. */
export async function primaryConfigId(
  db: Db,
  accountId: string
): Promise<string | null> {
  const { data } = await db
    .from('whatsapp_config')
    .select('id')
    .eq('account_id', accountId)
    .eq('is_primary', true)
    .maybeSingle();
  return (data?.id as string | undefined) ?? null;
}

/**
 * The number a send uses when the caller did not pick one: the WAHA
 * channel if given, else the primary official number.
 */
export async function defaultNumber(
  db: Db,
  accountId: string,
  channelId: string | null = null
): Promise<ConversationNumber> {
  return channelId
    ? { channelId, configId: null }
    : { channelId: null, configId: await primaryConfigId(db, accountId) };
}

/**
 * The contact's conversation on this number, or null. A conversation from
 * before migration 114 on the official API with no number recorded is
 * adopted by the official number asking for it (and stamped), so old
 * threads keep receiving instead of being split off.
 */
export async function findConversationOnNumber<T = Record<string, unknown>>(
  db: Db,
  accountId: string,
  contactId: string,
  number: ConversationNumber,
  select = '*'
): Promise<T | null> {
  let q = db
    .from('conversations')
    .select(select)
    .eq('account_id', accountId)
    .eq('contact_id', contactId);
  if (number.channelId) {
    q = q.eq('whatsapp_channel_id', number.channelId);
  } else {
    q = q.is('whatsapp_channel_id', null);
    q = number.configId
      ? q.eq('whatsapp_config_id', number.configId)
      : q.is('whatsapp_config_id', null);
  }
  const { data, error } = await q
    .order('created_at', { ascending: true })
    .limit(1);
  if (error) throw error;
  if (data && data.length > 0) return data[0] as T;

  if (!number.channelId && number.configId) {
    const { data: legacy } = await db
      .from('conversations')
      .select('id')
      .eq('account_id', accountId)
      .eq('contact_id', contactId)
      .is('whatsapp_channel_id', null)
      .is('whatsapp_config_id', null)
      .order('created_at', { ascending: true })
      .limit(1);
    const legacyId = legacy?.[0]?.id as string | undefined;
    if (legacyId) {
      await db
        .from('conversations')
        .update({ whatsapp_config_id: number.configId })
        .eq('id', legacyId)
        .is('whatsapp_config_id', null);
      const { data: adopted } = await db
        .from('conversations')
        .select(select)
        .eq('id', legacyId)
        .maybeSingle();
      return (adopted as T | null) ?? null;
    }
  }
  return null;
}

/** Columns that put a new conversation on this number. */
export function numberColumns(number: ConversationNumber) {
  return {
    whatsapp_channel_id: number.channelId,
    whatsapp_config_id: number.channelId ? null : number.configId,
  };
}
