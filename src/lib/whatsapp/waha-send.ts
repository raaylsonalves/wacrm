// Engine-side sends for conversations on a WAHA (QR) channel.
//
// The AI auto-reply, Flows, automations and follow-ups all sent through
// the account's official number — for a conversation that came in on a
// QR-connected number that meant answering from a DIFFERENT WhatsApp
// (or failing with "WhatsApp not configured" when there is no official
// number), while the inbox showed it as the same thread (review 2026-10,
// M1). Text goes out over the conversation's own channel, through the
// same anti-ban throttle as a manual send; anything WAHA cannot send
// (templates, interactive, media) fails loudly instead of leaking out of
// the official number.

import type { SupabaseClient } from '@supabase/supabase-js';
import { decrypt } from './encryption';
import { sendWahaText, toWahaChatId } from './waha-api';
import { claimWahaSendSlot } from './waha-throttle';

export interface WahaChannelRow {
  id: string;
  waha_base_url: string;
  waha_api_key: string;
  waha_session_name: string;
  connected_at: string | null;
}

/** The conversation's WAHA channel, or null for an official-number thread. */
export async function wahaChannelOfConversation(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: SupabaseClient<any, any, any>,
  accountId: string,
  conversationId: string | null | undefined
): Promise<WahaChannelRow | null> {
  if (!conversationId) return null;
  const { data: conv } = await db
    .from('conversations')
    .select('whatsapp_channel_id')
    .eq('id', conversationId)
    .eq('account_id', accountId)
    .maybeSingle();
  const channelId = conv?.whatsapp_channel_id as string | null | undefined;
  if (!channelId) return null;
  const { data: channel } = await db
    .from('whatsapp_waha_channels')
    .select('id, waha_base_url, waha_api_key, waha_session_name, connected_at')
    .eq('id', channelId)
    .eq('account_id', accountId)
    .maybeSingle();
  if (!channel) {
    throw new Error("this conversation's QR (WAHA) channel no longer exists");
  }
  return channel as WahaChannelRow;
}

/** Text over a WAHA channel, after the anti-ban throttle. Returns its id. */
export async function sendTextOverWaha(
  channel: WahaChannelRow,
  phone: string,
  text: string
): Promise<string> {
  await claimWahaSendSlot(channel.id, { connectedAt: channel.connected_at });
  const r = await sendWahaText(
    channel.waha_base_url,
    decrypt(channel.waha_api_key),
    channel.waha_session_name,
    toWahaChatId(phone),
    text
  );
  return r.id;
}

/** Thrown by senders of what a WAHA channel cannot carry. */
export class WahaUnsupportedError extends Error {
  constructor(what: string) {
    super(
      `this conversation is on a QR (WAHA) channel, which cannot send ${what}`
    );
  }
}
