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
import { findConversationOnNumber } from '@/lib/whatsapp/conversation-number';

import { decrypt } from '@/lib/whatsapp/encryption';
import {
  downloadWahaMedia,
  fromWahaChatId,
  phoneFromWahaAlt,
  resolveWahaLid,
  wahaMediaUrl,
} from '@/lib/whatsapp/waha-api';
import { mirrorInboundMedia } from '@/lib/whatsapp/mirror-inbound-media';
import { verifyWahaWebhookSignature } from '@/lib/whatsapp/waha-webhook-signature';
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe';
import { isOptOutMessage } from '@/lib/contacts/opt-out';
import { confirmOptOut } from '@/lib/contacts/opt-out-confirm';
import { reopenClosedConversation } from '@/lib/conversations/reopen';
import { runAutomationsForTrigger } from '@/lib/automations/engine';
import { hoursSincePreviousCustomerMessage } from '@/lib/automations/arrival';
import { dispatchInboundToFlows } from '@/lib/flows/engine';
import { dispatchInboundToAiReply } from '@/lib/ai/auto-reply';
import { pushInboundMessage } from '@/lib/push/send';
import type { ContentType } from '@/types';
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver';
import { supabaseAdmin } from '@/lib/whatsapp/waha-admin-client';
import {
  adReferralFromRaw,
  codesIn,
  detectOrigin,
  type MetaReferral,
} from '@/lib/leads/origin';

interface WahaMessagePayload {
  id: string;
  from: string;
  /** The recipient — the customer, on a message our own number sent. */
  to?: string;
  fromMe?: boolean;
  /** 'api' = sent through WAHA (the CRM), 'app' = typed on the phone. */
  source?: string;
  body?: string;
  hasMedia?: boolean;
  media?: { url?: string; mimetype?: string };
  timestamp?: number;
  _data?: {
    key?: Record<string, unknown>;
    pushName?: string;
    notifyName?: string;
    message?: Record<string, unknown>;
  } | null;
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

/**
 * A sender hidden behind a WhatsApp privacy id (`…@lid`): ask WAHA for the
 * real number. Without it the reply would go to `<lid>@c.us`, nobody.
 */
async function wahaCreds(
  channelId: string
): Promise<{ baseUrl: string; apiKey: string; session: string } | null> {
  const { data } = await supabaseAdmin()
    .from('whatsapp_waha_channels')
    .select('waha_base_url, waha_api_key, waha_session_name')
    .eq('id', channelId)
    .maybeSingle();
  if (!data) return null;
  try {
    return {
      baseUrl: data.waha_base_url as string,
      apiKey: decrypt(data.waha_api_key as string),
      session: data.waha_session_name as string,
    };
  } catch (err) {
    console.error('[webhook/waha] could not decrypt the channel key:', err);
    return null;
  }
}

async function phoneOfLid(
  channelId: string,
  lid: string
): Promise<string | null> {
  const creds = await wahaCreds(channelId);
  if (!creds) return null;
  try {
    return await resolveWahaLid(
      creds.baseUrl,
      creds.apiKey,
      creds.session,
      lid
    );
  } catch (err) {
    console.error('[webhook/waha] could not resolve', lid, err);
    return null;
  }
}

/** The sender's WhatsApp profile name, when WAHA sends one. */
function wahaProfileName(payload: WahaMessagePayload): string | null {
  const raw = payload._data?.pushName ?? payload._data?.notifyName ?? '';
  const name = raw.trim().slice(0, 120);
  return name && !/^[+\d\s()-]+$/.test(name) ? name : null;
}

/** Same first-touch rule as the Cloud API webhook's recordLeadOrigin. */
async function recordLeadOrigin(
  db: ReturnType<typeof supabaseAdmin>,
  accountId: string,
  contactId: string,
  referral: MetaReferral | null,
  text: string
) {
  try {
    const codes = codesIn(text);
    const { data: links } = codes.length
      ? await db
          .from('tracking_links')
          .select('code, label')
          .eq('account_id', accountId)
          .in('code', codes)
      : { data: [] };
    const origin = detectOrigin(referral, text, links ?? []);
    await db
      .from('contacts')
      .update({
        lead_source: origin.source,
        lead_source_detail: origin.detail,
        lead_source_at: new Date().toISOString(),
      })
      .eq('id', contactId)
      .eq('account_id', accountId)
      .is('lead_source', null);
  } catch (err) {
    console.error('[webhook/waha] lead origin not recorded:', err);
  }
}

/**
 * WAHA reports media at its own container address (localhost) behind the
 * API key, and deletes the file minutes later. Fetch it from the public
 * base URL and keep a copy in chat-media, so the inbox can play it and
 * the AI can transcribe it.
 */
async function storeWahaMedia(
  channelId: string,
  accountId: string,
  payload: WahaMessagePayload
): Promise<{
  mediaUrl: string | null;
  fetchMedia: (() => Promise<{ buffer: Buffer; contentType: string }>) | null;
}> {
  if (!payload.hasMedia || !payload.media?.url) {
    return { mediaUrl: payload.media?.url ?? null, fetchMedia: null };
  }
  const creds = await wahaCreds(channelId);
  if (!creds) return { mediaUrl: payload.media.url, fetchMedia: null };
  const url = wahaMediaUrl(payload.media.url, creds.baseUrl);
  const fetchMedia = () => downloadWahaMedia(url, creds.apiKey);
  const mirrored = await mirrorInboundMedia({
    storage: supabaseAdmin().storage,
    accountId,
    mediaId: payload.id.replace(/[^A-Za-z0-9]/g, '').slice(-24) || 'waha',
    downloadUrl: url,
    accessToken: '',
    mimeType: payload.media.mimetype ?? null,
    messageTimestamp: payload.timestamp ?? null,
    download: fetchMedia,
  }).catch((err) => {
    console.error('[webhook/waha] media mirror failed:', err);
    return null;
  });
  return { mediaUrl: mirrored ?? url, fetchMedia };
}

/**
 * A message our own number sent (needs the `message.any` event). Sends
 * made through WAHA — the AI, an agent in the inbox, automations — are
 * stored by the CRM already; one typed on the phone is not. Store it as
 * the team's reply and pause the AI, so it does not talk over a person
 * (same as WhatsApp Business coexistence: handoff reason phone_reply).
 */
async function handleOwnMessage(
  channel: { id: string; account_id: string },
  payload: WahaMessagePayload
) {
  const to = payload.to ?? '';
  if (!to || to.endsWith('@g.us') || /@(broadcast|newsletter)$/.test(to)) {
    return;
  }
  if (payload.source === 'api') return;

  const db = supabaseAdmin();
  // NOWEB ids are `true_<chat>_<KEYID>`; the CRM stores the KEYID it got
  // back from the send. Without `source` (older WAHA) an API send echoes
  // here too — give the CRM's own insert a moment, then look for it.
  const keyId = payload.id.split('_').pop() || payload.id;
  if (payload.source !== 'app') await new Promise((r) => setTimeout(r, 4000));
  const { data: ours } = await db
    .from('messages')
    .select('id')
    .in('message_id', [keyId, payload.id])
    .limit(1);
  if (ours && ours.length > 0) return;

  const phone = to.endsWith('@lid')
    ? (phoneFromWahaAlt(payload) ?? (await phoneOfLid(channel.id, to)) ?? to)
    : fromWahaChatId(to);
  const contact = await findExistingContact(db, channel.account_id, phone);
  if (!contact) return;
  const conversation = await findConversationOnNumber(
    db,
    channel.account_id,
    contact.id,
    { channelId: channel.id, configId: null }
  ).catch(() => null);
  if (!conversation) return;

  const contentType = payload.hasMedia
    ? mediaContentType(payload.media?.mimetype)
    : 'text';
  const { mediaUrl } = await storeWahaMedia(
    channel.id,
    channel.account_id,
    payload
  );
  const text = payload.body?.trim() || null;
  const createdAt = payload.timestamp
    ? new Date(payload.timestamp * 1000).toISOString()
    : new Date().toISOString();
  const { data: inserted, error } = await db
    .from('messages')
    .upsert(
      {
        conversation_id: conversation.id,
        sender_type: 'agent',
        sent_from: 'business_app',
        content_type: contentType,
        content_text: text,
        media_url: mediaUrl,
        message_id: keyId,
        status: 'sent',
        created_at: createdAt,
      },
      { onConflict: 'conversation_id,message_id', ignoreDuplicates: true }
    )
    .select('id');
  if (error) {
    console.error('[webhook/waha] own message insert failed:', error);
    return;
  }
  if (!inserted || inserted.length === 0) return;

  await db
    .from('conversations')
    .update({
      last_message_text: text || `[${contentType}]`,
      last_message_at: createdAt,
      last_message_sender_type: 'agent',
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversation.id);
  await db
    .from('conversations')
    .update({ ai_autoreply_disabled: true, ai_handoff_reason: 'phone_reply' })
    .eq('id', conversation.id)
    .eq('ai_autoreply_disabled', false);
}

async function handleMessage(
  channel: { id: string; account_id: string; created_by: string },
  payload: WahaMessagePayload
) {
  // Echo of our own outbound send (WAHA reports fromMe=true) — not an
  // inbound message. Group chats (`@g.us`) are out of scope for the
  // same reason the Cloud API webhook skips them: there's no CRM
  // contact binding for a group.
  if (payload.fromMe) return handleOwnMessage(channel, payload);
  if (payload.from?.endsWith('@g.us')) return;
  // Status updates (`status@broadcast`), broadcast lists and channels
  // (`@newsletter`) are not a customer writing to the business.
  if (/@(broadcast|newsletter)$/.test(payload.from ?? '')) return;

  // Unresolved, the contact keeps the LID itself (`…@lid`): replies then
  // go to that chat id as-is (toWahaChatId), which WAHA accepts.
  const phone = payload.from?.endsWith('@lid')
    ? (phoneFromWahaAlt(payload) ??
      (await phoneOfLid(channel.id, payload.from)) ??
      payload.from)
    : fromWahaChatId(payload.from);
  if (phone?.endsWith('@lid')) {
    // Which fields this WAHA version sends, to read the number from them.
    console.warn('[webhook/waha] LID sender without a number', {
      key: payload._data?.key ?? null,
      dataKeys: Object.keys(payload._data ?? {}),
    });
  }
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
  let contactCreated = false;
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
      contactCreated = true;
    }
  }
  if (!contact) return;

  // The WhatsApp profile name (NOWEB `pushName`, WEBJS `notifyName`):
  // fills a contact that has none, never overwrites one the team typed.
  const profileName = wahaProfileName(payload);
  if (profileName && !(contact as { name?: string | null }).name) {
    await db
      .from('contacts')
      .update({ name: profileName })
      .eq('id', contact.id)
      .eq('account_id', accountId)
      .is('name', null);
  }

  // One conversation per (contact, number) — migration 114: this
  // channel's thread with the contact, not whichever thread is oldest.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a conversations row, as before
  let conversation: ({ id: string } & Record<string, any>) | null = null;
  try {
    conversation = await findConversationOnNumber(db, accountId, contact.id, {
      channelId: channel.id,
      configId: null,
    });
  } catch (convFindErr) {
    console.error('[webhook/waha] conversation lookup failed:', convFindErr);
    return;
  }
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
      // Two deliveries for a new contact at once: the other one created
      // the thread (one per contact + number, migration 114). Join it
      // instead of dropping this message (review 2026-10, M5).
      if (isUniqueViolation(convInsertErr)) {
        conversation = (await findConversationOnNumber(
          db,
          accountId,
          contact.id,
          {
            channelId: channel.id,
            configId: null,
          }
        ).catch(() => null)) as typeof conversation;
      }
      if (!conversation) {
        console.error(
          '[webhook/waha] conversation insert failed:',
          convInsertErr
        );
        return;
      }
    } else {
      conversation = newConv;
      conversationCreated = true;
    }
  }
  if (!conversation) return;

  if (conversationCreated) {
    await dispatchWebhookEvent(db, accountId, 'conversation.created', {
      conversation_id: conversation.id,
      contact_id: contact.id,
    });
  }

  const contentText = payload.body ?? '';
  // Click-to-WhatsApp ad (Instagram/Facebook): first touch + AI context.
  const adReferral = adReferralFromRaw(payload._data);
  if (contactCreated || adReferral) {
    await recordLeadOrigin(db, accountId, contact.id, adReferral, contentText);
  }
  const contentType = payload.hasMedia
    ? mediaContentType(payload.media?.mimetype)
    : 'text';

  const { mediaUrl, fetchMedia } = await storeWahaMedia(
    channel.id,
    accountId,
    payload
  );

  const { data: insertedMsg, error: msgErr } = await db
    .from('messages')
    .upsert(
      {
        conversation_id: conversation.id,
        sender_type: 'customer',
        content_type: contentType,
        content_text: contentText || null,
        media_url: mediaUrl,
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

  // Web Push — same placement and reasoning as the Cloud API webhook.
  await pushInboundMessage(db, accountId, {
    id: insertedMsg[0].id,
    conversation_id: conversation.id,
    sender_type: 'customer',
    content_type: contentType as ContentType,
    content_text: contentText || null,
  });

  if (isOptOutMessage(contentText)) {
    await db
      .from('contacts')
      .update({ opted_out_at: new Date().toISOString() })
      .eq('id', contact.id)
      .eq('account_id', accountId)
      .is('opted_out_at', null);
    // Confirmed whatever the AI's state (migration 101) — same as the
    // Cloud API webhook.
    await confirmOptOut(db, {
      accountId,
      contactId: contact.id,
      conversationId: conversation.id,
      userId: ownerUserId,
    });
  }

  // The contact's first message ever, across all of its conversations
  // (this one is already stored): drives the welcome automations and
  // first_inbound_message flows, as in the Cloud API webhook.
  const { data: contactConvs } = await db
    .from('conversations')
    .select('id')
    .eq('account_id', accountId)
    .eq('contact_id', contact.id);
  const { count: customerMsgCount } = await db
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .in(
      'conversation_id',
      (contactConvs ?? []).map((c: { id: string }) => c.id)
    )
    .eq('sender_type', 'customer');
  const isFirstInboundMessage = (customerMsgCount ?? 0) <= 1;

  const idleHoursBefore = await hoursSincePreviousCustomerMessage(
    db,
    accountId,
    contact.id
  );

  const flowResult = await dispatchInboundToFlows({
    accountId,
    userId: ownerUserId,
    contactId: contact.id,
    conversationId: conversation.id,
    message: { kind: 'text', text: contentText, meta_message_id: payload.id },
    isFirstInboundMessage,
  });

  // Welcome automations run before the AI answers the same message.
  const triggers: (
    | 'customer_arrived'
    | 'first_inbound_message'
    | 'new_contact_created'
    | 'new_message_received'
    | 'keyword_match'
  )[] = [
    'customer_arrived',
    ...(isFirstInboundMessage ? (['first_inbound_message'] as const) : []),
    ...(contactCreated ? (['new_contact_created'] as const) : []),
    ...(flowResult.consumed
      ? []
      : (['new_message_received', 'keyword_match'] as const)),
  ];
  for (const triggerType of triggers) {
    await runAutomationsForTrigger({
      accountId,
      triggerType,
      contactId: contact.id,
      context: {
        message_text: contentText,
        conversation_id: conversation.id,
        idle_hours: idleHoursBefore,
      },
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
      // A voice note is transcribed before the AI answers it
      // (specs/ai-audio-inbound.md), as on the Cloud API.
      audio:
        contentType === 'audio' && fetchMedia
          ? { messageRowId: insertedMsg[0].id as string, fetchFile: fetchMedia }
          : undefined,
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
      } else if (body.event === 'message' || body.event === 'message.any') {
        await handleMessage(channel, body.payload as WahaMessagePayload);
      }
    } catch (err) {
      console.error('[webhook/waha] processing failed:', err);
    }
  });

  return NextResponse.json({ received: true });
}
