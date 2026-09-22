// ============================================================
// POST /api/whatsapp/webhook/waha
//
// Inbound entrypoint for WAHA-connected channels — the WAHA sibling
// of /api/whatsapp/webhook (Cloud API). Scoped to
// specs/waha-channel-connection.md's first slice: text + a passthrough
// of whatever media URL WAHA reports. No reactions, no swipe-reply
// context, no interactive taps yet — those stay Cloud-API-only until
// there's a reason to invest in the WAHA-specific shapes for them.
//
// Every downstream step below (contact/conversation persistence via
// the SAME `contacts`/`conversations`/`messages` tables, then Flows →
// automations → AI auto-reply → outbound webhooks) reuses the exact
// same shared lib functions the Cloud API webhook calls — this is the
// "one pipeline, two front doors" seam specs/waha-channel-connection.md
// asked for, achieved without touching the Cloud API route at all.
// ============================================================

import { NextResponse, after } from 'next/server';

import { decrypt } from '@/lib/whatsapp/encryption';
import { fromWahaChatId } from '@/lib/whatsapp/waha-api';
import { verifyWahaWebhookSignature } from '@/lib/whatsapp/waha-webhook-signature';
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe';
import { isOptOutMessage } from '@/lib/contacts/opt-out';
import { reopenClosedConversation } from '@/lib/conversations/reopen';
import { runAutomationsForTrigger } from '@/lib/automations/engine';
import { dispatchInboundToFlows } from '@/lib/flows/engine';
import { dispatchInboundToAiReply } from '@/lib/ai/auto-reply';
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver';
import { supabaseAdmin } from '@/lib/whatsapp/waha-admin-client';

interface WahaMessagePayload {
  id: string;
  from: string;
  fromMe?: boolean;
  body?: string;
  hasMedia?: boolean;
  media?: { url?: string; mimetype?: string };
  timestamp?: number;
}

interface WahaSessionStatusPayload {
  status?: string;
}

interface WahaWebhookBody {
  event: 'message' | 'session.status' | string;
  session: string;
  payload: WahaMessagePayload | WahaSessionStatusPayload;
}

async function handleSessionStatus(
  channel: { id: string },
  payload: WahaSessionStatusPayload
) {
  const status = payload.status;
  const nextStatus =
    status === 'WORKING'
      ? 'connected'
      : status === 'FAILED' || status === 'STOPPED'
        ? 'disconnected'
        : null;
  if (!nextStatus) return;

  await supabaseAdmin()
    .from('whatsapp_waha_channels')
    .update({
      status: nextStatus,
      connected_at:
        nextStatus === 'connected' ? new Date().toISOString() : undefined,
    })
    .eq('id', channel.id);
}

function mediaContentType(mimetype: string | undefined): string {
  if (!mimetype) return 'document';
  if (mimetype.startsWith('image/')) return 'image';
  if (mimetype.startsWith('video/')) return 'video';
  if (mimetype.startsWith('audio/')) return 'audio';
  return 'document';
}

async function handleMessage(
  channel: { id: string; account_id: string; created_by: string },
  payload: WahaMessagePayload
) {
  // Echo of our own outbound send (WAHA reports fromMe=true) — not an
  // inbound message. Group chats (`@g.us`) are out of scope for the
  // same reason the Cloud API webhook skips them: there's no CRM
  // contact binding for a group.
  if (payload.fromMe) return;
  if (payload.from?.endsWith('@g.us')) return;

  const phone = fromWahaChatId(payload.from);
  if (!phone) {
    console.error(
      '[webhook/waha] message has no usable sender id:',
      payload.id
    );
    return;
  }

  const db = supabaseAdmin();
  const accountId = channel.account_id;
  const ownerUserId = channel.created_by;

  let contact = await findExistingContact(db, accountId, phone);
  if (!contact) {
    const { data: inserted, error: insertErr } = await db
      .from('contacts')
      .insert({ account_id: accountId, user_id: ownerUserId, phone })
      .select()
      .maybeSingle();
    if (insertErr) {
      // Lost a race with a concurrent delivery for the same number —
      // re-resolve the winner instead of dropping the message (same
      // pattern as the Cloud API webhook's findOrCreateContact).
      if (isUniqueViolation(insertErr)) {
        contact = await findExistingContact(db, accountId, phone);
      }
      if (!contact) {
        console.error('[webhook/waha] contact insert failed:', insertErr);
        return;
      }
    } else {
      contact = inserted as typeof contact;
    }
  }
  if (!contact) return;

  const { data: existingConvRows, error: convFindErr } = await db
    .from('conversations')
    .select('*')
    .eq('account_id', accountId)
    .eq('contact_id', contact.id)
    .order('created_at', { ascending: true })
    .limit(1);
  if (convFindErr) {
    console.error('[webhook/waha] conversation lookup failed:', convFindErr);
    return;
  }

  let conversation = existingConvRows?.[0] ?? null;
  let conversationCreated = false;
  if (!conversation) {
    const { data: newConv, error: convInsertErr } = await db
      .from('conversations')
      .insert({
        account_id: accountId,
        user_id: ownerUserId,
        contact_id: contact.id,
        whatsapp_channel_id: channel.id,
      })
      .select()
      .single();
    if (convInsertErr) {
      console.error(
        '[webhook/waha] conversation insert failed:',
        convInsertErr
      );
      return;
    }
    conversation = newConv;
    conversationCreated = true;
  } else if (!conversation.whatsapp_channel_id) {
    // First message on a pre-existing (e.g. manually created)
    // conversation that had no channel yet — bind it now so outbound
    // replies know to go back out over WAHA.
    await db
      .from('conversations')
      .update({ whatsapp_channel_id: channel.id })
      .eq('id', conversation.id);
    conversation.whatsapp_channel_id = channel.id;
  }

  if (conversationCreated) {
    await dispatchWebhookEvent(db, accountId, 'conversation.created', {
      conversation_id: conversation.id,
      contact_id: contact.id,
    });
  }

  const contentText = payload.body ?? '';
  const contentType = payload.hasMedia
    ? mediaContentType(payload.media?.mimetype)
    : 'text';

  const { data: insertedMsg, error: msgErr } = await db
    .from('messages')
    .upsert(
      {
        conversation_id: conversation.id,
        sender_type: 'customer',
        content_type: contentType,
        content_text: contentText || null,
        media_url: payload.media?.url ?? null,
        message_id: payload.id,
        status: 'delivered',
        created_at: payload.timestamp
          ? new Date(payload.timestamp * 1000).toISOString()
          : new Date().toISOString(),
      },
      { onConflict: 'conversation_id,message_id', ignoreDuplicates: true }
    )
    .select('id');

  if (msgErr) {
    console.error('[webhook/waha] message insert failed:', msgErr);
    return;
  }
  if (!insertedMsg || insertedMsg.length === 0) {
    // Duplicate delivery — WAHA (like Meta) can redeliver. Idempotent
    // no-op, same reasoning as the Cloud API webhook.
    return;
  }

  await db.rpc('bump_conversation_on_inbound', {
    p_conversation_id: conversation.id,
    p_last_message_text: contentText || `[${contentType}]`,
  });
  await reopenClosedConversation(db, conversation);

  if (isOptOutMessage(contentText)) {
    await db
      .from('contacts')
      .update({ opted_out_at: new Date().toISOString() })
      .eq('id', contact.id)
      .eq('account_id', accountId)
      .is('opted_out_at', null);
  }

  const flowResult = await dispatchInboundToFlows({
    accountId,
    userId: ownerUserId,
    contactId: contact.id,
    conversationId: conversation.id,
    message: { kind: 'text', text: contentText, meta_message_id: payload.id },
    isFirstInboundMessage: false,
  });

  const triggers: ('new_message_received' | 'keyword_match')[] =
    flowResult.consumed ? [] : ['new_message_received', 'keyword_match'];
  for (const triggerType of triggers) {
    await runAutomationsForTrigger({
      accountId,
      triggerType,
      contactId: contact.id,
      context: { message_text: contentText, conversation_id: conversation.id },
    }).catch((err) =>
      console.error('[webhook/waha] automation dispatch failed:', err)
    );
  }

  if (!flowResult.consumed) {
    await dispatchInboundToAiReply({
      accountId,
      conversationId: conversation.id,
      contactId: contact.id,
      configOwnerUserId: ownerUserId,
    }).catch((err) =>
      console.error('[webhook/waha] AI auto-reply dispatch failed:', err)
    );
  }

  await dispatchWebhookEvent(db, accountId, 'message.received', {
    conversation_id: conversation.id,
    contact_id: contact.id,
    message_id: payload.id,
    content_text: contentText,
  });
}

export async function POST(request: Request) {
  const rawBody = await request.text();

  let body: WahaWebhookBody;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  if (!body.session) {
    return NextResponse.json({ error: 'Missing session' }, { status: 400 });
  }

  const { data: channel, error } = await supabaseAdmin()
    .from('whatsapp_waha_channels')
    .select('id, account_id, created_by, webhook_secret')
    .eq('waha_session_name', body.session)
    .maybeSingle();

  if (error || !channel) {
    // Unknown session — either a stale/deleted channel or a forged
    // request. Either way there's no secret to verify against, so
    // there's nothing more to check: reject.
    console.warn('[webhook/waha] unknown session, rejecting:', body.session);
    return NextResponse.json({ error: 'Unknown session' }, { status: 404 });
  }

  const signature = request.headers.get('x-webhook-hmac');
  if (
    !verifyWahaWebhookSignature(
      rawBody,
      signature,
      decrypt(channel.webhook_secret)
    )
  ) {
    console.warn('[webhook/waha] rejected request with invalid signature');
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  after(async () => {
    try {
      if (body.event === 'session.status') {
        await handleSessionStatus(
          channel,
          body.payload as WahaSessionStatusPayload
        );
      } else if (body.event === 'message') {
        await handleMessage(channel, body.payload as WahaMessagePayload);
      }
    } catch (err) {
      console.error('[webhook/waha] processing failed:', err);
    }
  });

  return NextResponse.json({ received: true });
}
