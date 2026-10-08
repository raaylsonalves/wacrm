import type { SupabaseClient } from '@supabase/supabase-js';
import {
  findConversationOnNumber,
  defaultNumber,
  numberColumns,
} from '@/lib/whatsapp/conversation-number';

/**
 * Put a sent broadcast message into the contact's conversation, so the
 * thread shows what the customer is replying to — and the AI, follow-ups
 * and the conversation summary have that context too.
 *
 *  - Goes into the conversation the webhooks file replies into (the
 *    contact's oldest). A new one records the channel it went out on
 *    (null = the Cloud API number).
 *  - An existing conversation only gets the message: its last-message
 *    fields are left alone on purpose. Bumping them would make an open
 *    AI thread look like "we spoke last" and could start a follow-up
 *    sequence off a marketing blast.
 *  - With no conversation yet, one is created already CLOSED: a campaign
 *    to a thousand contacts must not open a thousand inbox threads. The
 *    webhook reopens it when the customer answers.
 *  - `message_id` carries Meta's id, so delivered/read ticks land on it.
 *
 * Best-effort: never throws — the send already happened; a failure here
 * costs the thread entry, never the broadcast.
 */
export async function recordBroadcastMessage(
  db: SupabaseClient,
  args: {
    accountId: string;
    contactId: string;
    channelId: string | null;
    text: string | null;
    templateName: string;
    waMessageId: string | null;
  }
): Promise<void> {
  try {
    const { data: contact } = await db
      .from('contacts')
      .select('id')
      .eq('id', args.contactId)
      .eq('account_id', args.accountId)
      .maybeSingle();
    if (!contact) return; // not this account's contact: nothing to write

    // Same rule both webhooks use to file the customer's reply: the
    // contact's conversation on the number that sent the blast (migration
    // 114) — otherwise the blast and the answer could land in different
    // threads.
    const number = await defaultNumber(db, args.accountId, args.channelId);
    const existing = await findConversationOnNumber<{ id: string }>(
      db,
      args.accountId,
      args.contactId,
      number,
      'id'
    );

    const preview = args.text?.trim() || `[template:${args.templateName}]`;
    let conversationId = existing?.id as string | undefined;
    if (!conversationId) {
      const owner = await accountOwner(db, args.accountId);
      if (!owner) return;
      const now = new Date().toISOString();
      const { data: created, error } = await db
        .from('conversations')
        .insert({
          account_id: args.accountId,
          user_id: owner,
          contact_id: args.contactId,
          ...numberColumns(number),
          status: 'closed',
          last_message_text: preview,
          last_message_at: now,
          last_message_sender_type: 'bot',
        })
        .select('id')
        .single();
      if (error || !created) {
        console.warn(
          '[broadcast-record] conversation insert failed:',
          error?.message
        );
        return;
      }
      conversationId = created.id as string;
    }

    const { error: msgErr } = await db.from('messages').insert({
      conversation_id: conversationId,
      sender_type: 'bot',
      content_type: 'template',
      content_text: args.text,
      template_name: args.templateName,
      message_id: args.waMessageId,
      status: 'sent',
    });
    if (msgErr)
      console.warn('[broadcast-record] message insert failed:', msgErr.message);
  } catch (err) {
    console.warn(
      '[broadcast-record] failed:',
      err instanceof Error ? err.message : err
    );
  }
}

async function accountOwner(
  db: SupabaseClient,
  accountId: string
): Promise<string | null> {
  const { data } = await db
    .from('accounts')
    .select('owner_user_id')
    .eq('id', accountId)
    .maybeSingle();
  return (data?.owner_user_id as string | undefined) ?? null;
}
