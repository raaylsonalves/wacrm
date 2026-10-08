// ============================================================
// Public-API broadcast core.
//
// Splits a broadcast into two phases so the HTTP route can persist +
// acknowledge fast and fan out afterwards (in `after()`):
//
//   createBroadcast()  — validate, resolve contacts, insert the
//                        `broadcasts` row + `broadcast_recipients`
//                        rows (status 'pending'), return a plan.
//   deliverBroadcast() — send each recipient's template via Meta
//                        (phone-variant retry), stamp each recipient
//                        row + the aggregate counts, finalize status.
//
// Recipient rows carry `whatsapp_message_id`, so the inbound webhook's
// status handler (which matches on that column) updates delivered/read
// for API broadcasts exactly as it does for dashboard ones.
// ============================================================

import { recordBroadcastMessage } from './broadcast-record';
import type { SupabaseClient } from '@supabase/supabase-js';

import { audit } from '@/lib/audit';
import { sendTemplateMessage } from '@/lib/whatsapp/meta-api';
import { decrypt } from '@/lib/whatsapp/encryption';
import {
  sanitizePhoneForMeta,
  isValidE164,
  phoneVariants,
  isRecipientNotAllowedError,
} from '@/lib/whatsapp/phone-utils';
import {
  resolveTemplateRow,
  templateContentText,
} from '@/lib/whatsapp/template-body';
import type { MessageTemplate } from '@/types';
import { findOrCreateContact } from '@/lib/api/v1/contacts';
import { sendWahaText, toWahaChatId, WahaApiError } from '@/lib/whatsapp/waha-api';
import { claimWahaSendSlot, WahaThrottleError } from '@/lib/whatsapp/waha-throttle';
import { pickNextChannel } from '@/lib/whatsapp/broadcast-rotation';

/** Thrown by createBroadcast on a caller-visible failure; route maps it. */
export class BroadcastError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'BroadcastError';
    this.code = code;
    this.status = status;
  }
}

export interface BroadcastRecipientInput {
  /** E.164 phone. */
  to: string;
  /** Positional body params for the template ({{1}}, {{2}}…). */
  params?: string[];
}

export interface CreateBroadcastParams {
  name?: string | null;
  templateName: string;
  templateLanguage?: string | null;
  recipients: BroadcastRecipientInput[];
  /** A WAHA channel id anchors this broadcast to WAHA instead of the
   *  account's Cloud API number (specs/broadcast-channel-rotation.md).
   *  Omitted/null = today's only mode, unchanged. */
  primaryChannelId?: string | null;
  /** Additional WAHA channels this broadcast may rotate across.
   *  Ignored unless `primaryChannelId` is set. */
  channelPoolIds?: string[];
}

interface PlannedRecipient {
  recipientRowId: string;
  phone: string;
  params: string[];
  /** For the conversation entry (broadcast-record.ts); absent = not recorded. */
  contactId?: string | null;
}

export interface BroadcastPlan {
  broadcastId: string;
  /** Needed to record each send in the contact's conversation. */
  accountId?: string;
  templateName: string;
  templateLanguage: string;
  /** Cloud API fields — empty strings in WAHA mode (unused there). */
  phoneNumberId: string;
  accessToken: string;
  templateRow: MessageTemplate | null;
  /** Set when this broadcast sends via WAHA. `null` = Cloud API,
   *  unchanged from before this feature. */
  primaryChannelId: string | null;
  channelPoolIds: string[];
  planned: PlannedRecipient[];
  /** Phones rejected up front (invalid E.164) — counted as failed. */
  rejected: number;
}

const MAX_RECIPIENTS = 1000;

/**
 * Validate + persist a broadcast, resolving each recipient to a
 * contact. Returns a plan for {@link deliverBroadcast}. Throws
 * {@link BroadcastError} on bad input / missing config / a malformed
 * template / a DB failure — nothing is sent in this phase.
 */
export async function createBroadcast(
  db: SupabaseClient,
  accountId: string,
  auditUserId: string,
  params: CreateBroadcastParams
): Promise<BroadcastPlan> {
  const { name, templateName, recipients, primaryChannelId } = params;
  const channelPoolIds = Array.isArray(params.channelPoolIds)
    ? params.channelPoolIds.filter((id): id is string => typeof id === 'string')
    : [];
  const isWahaBroadcast = !!primaryChannelId;

  if (!templateName) {
    throw new BroadcastError('bad_request', "'template_name' is required", 400);
  }
  if (!Array.isArray(recipients) || recipients.length === 0) {
    throw new BroadcastError(
      'bad_request',
      "'recipients' must be a non-empty array of { to, params? }",
      400
    );
  }
  if (recipients.length > MAX_RECIPIENTS) {
    throw new BroadcastError(
      'bad_request',
      `A broadcast is capped at ${MAX_RECIPIENTS} recipients per request; split larger sends`,
      400
    );
  }

  // Cloud API config, only needed in Cloud API mode — a WAHA
  // broadcast never touches whatsapp_config at all (specs/broadcast-
  // channel-rotation.md's whole point: an account with only WAHA
  // channels connected couldn't broadcast before this).
  let phoneNumberId = '';
  let accessToken = '';
  if (!isWahaBroadcast) {
    const { data: config, error: configError } = await db
      .from('whatsapp_config')
      .select('*')
      .eq('account_id', accountId)
      .eq('is_primary', true)
      .single();
    if (configError || !config) {
      throw new BroadcastError(
        'whatsapp_not_configured',
        'WhatsApp not configured. Please set up your WhatsApp integration first.',
        400
      );
    }
    accessToken = decrypt(config.access_token);
    phoneNumberId = config.phone_number_id;
  } else {
    // Every channel in the primary+pool set must actually belong to
    // this account — otherwise an account could broadcast through a
    // channel (and its stored credentials) that isn't theirs.
    const candidateIds = Array.from(new Set([primaryChannelId, ...channelPoolIds]));
    const { data: owned } = await db
      .from('whatsapp_waha_channels')
      .select('id')
      .eq('account_id', accountId)
      .in('id', candidateIds);
    const ownedIds = new Set((owned ?? []).map((c) => c.id));
    const missing = candidateIds.filter((id) => !ownedIds.has(id));
    if (missing.length > 0) {
      throw new BroadcastError(
        'bad_request',
        `Unknown WAHA channel id(s) for this account: ${missing.join(', ')}`,
        400
      );
    }
  }

  // Template row (once) for header/button components; guard a
  // malformed local row rather than N identical opaque failures.
  const resolvedTemplate = await resolveTemplateRow(
    db,
    accountId,
    templateName,
    params.templateLanguage
  );
  if (resolvedTemplate.malformed) {
    throw new BroadcastError(
      'template_malformed',
      'Template row is malformed locally — run "Sync from Meta" in Settings to repair it before broadcasting.',
      500
    );
  }
  const templateRow = resolvedTemplate.row;

  // WAHA has no template concept (specs/waha-channel-connection.md's
  // own scoping) — a WAHA broadcast sends the rendered body as plain
  // text, so without a locally-synced row's body_text there is
  // nothing to render at all (no Meta call to fall back on, unlike
  // the Cloud API path which can send by template name alone).
  if (isWahaBroadcast && !templateRow?.body_text) {
    throw new BroadcastError(
      'template_not_synced',
      'This template needs to be synced locally (Settings → Templates → Sync from Meta) before it can be used for a WAHA broadcast — WAHA sends the rendered text directly, with no Meta fallback.',
      400
    );
  }

  // Resolve each recipient to a contact. Invalid phones are dropped
  // (counted as rejected) rather than aborting the whole broadcast.
  const resolved: { contactId: string; phone: string; params: string[] }[] = [];
  let rejected = 0;
  for (const r of recipients) {
    const sanitized = sanitizePhoneForMeta(typeof r.to === 'string' ? r.to : '');
    if (!isValidE164(sanitized)) {
      rejected++;
      continue;
    }
    const { id } = await findOrCreateContact(db, accountId, auditUserId, {
      phone: sanitized,
    });
    resolved.push({
      contactId: id,
      phone: sanitized,
      params: Array.isArray(r.params)
        ? r.params.filter((p): p is string => typeof p === 'string')
        : [],
    });
  }

  // Collapse recipients that resolved to the SAME contact (the caller
  // listed a phone twice, or two numbers fuzzy-matched to one contact).
  // Keep the first occurrence so the contact is messaged once and its
  // params aren't silently overwritten by a later duplicate — and so
  // the row↔params pairing below (keyed by contact_id) is unambiguous.
  const seenContact = new Set<string>();
  const deduped = resolved.filter((r) => {
    if (seenContact.has(r.contactId)) return false;
    seenContact.add(r.contactId);
    return true;
  });

  if (deduped.length === 0) {
    throw new BroadcastError(
      'bad_request',
      'No recipients had a valid E.164 phone number',
      400
    );
  }

  // Persist the broadcast + its recipients. The count columns
  // (sent/delivered/read/replied/failed) are owned by the DB aggregate
  // trigger (migrations 003/005) and derived purely from
  // broadcast_recipients rows — we deliberately do NOT seed them here
  // (a manual value would be clobbered by the trigger on the first
  // recipient change). `rejected` phones have no recipient row, so they
  // are reported to the caller in the POST response, not in these
  // persisted counts.
  // Insert the parent broadcast and its recipient rows in ONE transaction
  // (migration 037's create_broadcast_with_recipients). Previously these
  // were two separate inserts: if the recipient insert failed, the parent
  // was already persisted with status 'sending' and no recipients, leaving
  // an orphaned campaign that looked like it was sending but had no
  // delivery plan (issue #370). The function body is atomic, so a recipient
  // failure now rolls the parent back and nothing orphaned survives.
  const { data: createdRows, error: createErr } = await db.rpc(
    'create_broadcast_with_recipients',
    {
      p_account_id: accountId,
      p_user_id: auditUserId,
      p_name: name || `API broadcast (${templateName})`,
      p_template_name: templateName,
      p_template_language: resolvedTemplate.language,
      p_total_recipients: deduped.length,
      p_contact_ids: deduped.map((r) => r.contactId),
      // Frozen per-recipient params (migration 038) — without them a
      // resume of this broadcast has no way to reconstruct {{1}}.
      p_template_params: deduped.map((r) => r.params),
      p_primary_channel_id: primaryChannelId ?? null,
    }
  );
  if (createErr || !createdRows || createdRows.length === 0) {
    console.error('[broadcast-core] create broadcast error:', createErr);
    throw new BroadcastError('internal', 'Failed to create broadcast', 500);
  }

  const broadcastId = createdRows[0].broadcast_id as string;

  if (isWahaBroadcast && channelPoolIds.length > 0) {
    const { error: poolErr } = await db.from('broadcast_channel_pool').insert(
      channelPoolIds.map((waha_channel_id) => ({
        broadcast_id: broadcastId,
        waha_channel_id,
      }))
    );
    if (poolErr) {
      // Non-fatal: the broadcast still works from the primary channel
      // alone, it just won't rotate. Log loudly rather than failing a
      // campaign that already committed its recipients.
      console.error('[broadcast-core] channel pool insert failed:', poolErr);
    }
  }

  // Pair each inserted recipient row back to its phone/params by
  // contact_id — unambiguous now that duplicates are collapsed.
  const byContact = new Map(deduped.map((r) => [r.contactId, r]));
  const planned: PlannedRecipient[] = createdRows.map(
    (row: { recipient_id: string; contact_id: string }) => {
      const r = byContact.get(row.contact_id)!;
      return {
        recipientRowId: row.recipient_id,
        phone: r.phone,
        params: r.params,
        contactId: row.contact_id,
      };
    }
  );

  // One row per dispatch, not per recipient — recipient-level detail
  // already lives in broadcast_recipients, and logging N rows here
  // for a large broadcast would be disproportionate volume for what
  // the audit trail needs to answer ("who fired this campaign").
  // Never the template body/params — those are the message content.
  void audit({
    accountId,
    actorUserId: auditUserId,
    action: 'broadcast.sent',
    resourceType: 'broadcast',
    resourceId: broadcastId,
    metadata: {
      template_name: templateName,
      recipient_count: planned.length,
      rejected_count: rejected,
    },
  });

  return {
    broadcastId,
    accountId,
    templateName,
    templateLanguage: resolvedTemplate.language,
    phoneNumberId,
    accessToken,
    templateRow,
    primaryChannelId: primaryChannelId ?? null,
    channelPoolIds,
    planned,
    rejected,
  };
}

/**
 * Fan out a {@link BroadcastPlan}: send each recipient's template
 * (phone-variant retry) and stamp its `broadcast_recipients` row.
 * Best-effort per recipient — one failure never aborts the rest.
 * Designed to run inside `after()`.
 *
 * The per-status count columns on `broadcasts` are owned by the DB
 * aggregate trigger (migrations 003/005): each recipient-row update
 * below advances them automatically, and later Meta delivery/read
 * webhooks keep advancing them. We therefore never write those columns
 * here — only the terminal `status` — otherwise a manual value would
 * race and clobber the trigger-maintained counts.
 */
export async function deliverBroadcast(
  db: SupabaseClient,
  plan: BroadcastPlan
): Promise<void> {
  for (const recipient of plan.planned) {
    if (plan.primaryChannelId) {
      await deliverWahaRecipient(db, plan, recipient);
      continue;
    }

    const variants = phoneVariants(recipient.phone);
    let sentMessageId: string | null = null;
    let lastError: string | null = null;

    for (const variant of variants) {
      try {
        const result = await sendTemplateMessage({
          phoneNumberId: plan.phoneNumberId,
          accessToken: plan.accessToken,
          to: variant,
          templateName: plan.templateName,
          language: plan.templateLanguage,
          template: plan.templateRow ?? undefined,
          params: recipient.params,
        });
        sentMessageId = result.messageId;
        lastError = null;
        break;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        lastError = message;
        // Only a "recipient not allowed" error is worth another variant.
        if (!isRecipientNotAllowedError(message)) break;
      }
    }

    if (sentMessageId) {
      await db
        .from('broadcast_recipients')
        .update({
          status: 'sent',
          sent_at: new Date().toISOString(),
          whatsapp_message_id: sentMessageId,
          error_message: null,
        })
        .eq('id', recipient.recipientRowId);
      if (plan.accountId && recipient.contactId) {
        await recordBroadcastMessage(db, {
          accountId: plan.accountId,
          contactId: recipient.contactId,
          channelId: null,
          text: templateContentText(plan.templateRow, recipient.params),
          templateName: plan.templateName,
          waMessageId: sentMessageId,
        });
      }
    } else {
      await db
        .from('broadcast_recipients')
        .update({
          status: 'failed',
          error_message: lastError || 'Unknown error',
        })
        .eq('id', recipient.recipientRowId);
    }
  }

  await finalizeBroadcastStatus(db, plan.broadcastId);
}

/**
 * One recipient of a WAHA broadcast: rotate to the least-recently-
 * used connected channel (specs/broadcast-channel-rotation.md),
 * throttle it (migration 064's `claim_waha_send_slot` — rotation
 * decides WHICH channel to ask, the throttle still decides WHETHER it
 * can send right now), then send the template's rendered text as a
 * plain WAHA message (no template/header/button concept there). No
 * phone-variant retry — that's a Meta "recipient not in allowed list"
 * workaround with no WAHA equivalent.
 */
async function deliverWahaRecipient(
  db: SupabaseClient,
  plan: BroadcastPlan,
  recipient: BroadcastPlan['planned'][number]
): Promise<void> {
  const text = templateContentText(plan.templateRow, recipient.params);
  if (!text) {
    await db
      .from('broadcast_recipients')
      .update({ status: 'failed', error_message: 'Template has no body text to send' })
      .eq('id', recipient.recipientRowId);
    return;
  }

  const channel = await pickNextChannel(
    db,
    plan.primaryChannelId!,
    plan.channelPoolIds
  );
  if (!channel) {
    await db
      .from('broadcast_recipients')
      .update({
        status: 'failed',
        error_message: 'No connected WAHA channel available in this broadcast\'s pool',
      })
      .eq('id', recipient.recipientRowId);
    return;
  }

  try {
    await claimWahaSendSlot(channel.id, {
      isBroadcast: true,
      connectedAt: channel.connected_at,
    });
    const result = await sendWahaText(
      channel.waha_base_url,
      decrypt(channel.waha_api_key),
      channel.waha_session_name,
      toWahaChatId(recipient.phone),
      text
    );
    await db
      .from('broadcast_recipients')
      .update({
        status: 'sent',
        sent_at: new Date().toISOString(),
        whatsapp_message_id: result.id,
        sent_via_channel_id: channel.id,
        error_message: null,
      })
      .eq('id', recipient.recipientRowId);
    if (plan.accountId && recipient.contactId) {
      await recordBroadcastMessage(db, {
        accountId: plan.accountId,
        contactId: recipient.contactId,
        channelId: channel.id,
        text,
        templateName: plan.templateName,
        waMessageId: null,
      });
    }
  } catch (err) {
    const message =
      err instanceof WahaThrottleError || err instanceof WahaApiError
        ? err.message
        : err instanceof Error
          ? err.message
          : 'Unknown WAHA error';
    await db
      .from('broadcast_recipients')
      .update({ status: 'failed', error_message: message })
      .eq('id', recipient.recipientRowId);
  }
}

/**
 * Flip a broadcast out of `sending` once no recipient is left pending.
 *
 * Derived from the recipient rows rather than from a counter local to
 * one delivery pass: a resume (issue #472) delivers only the leftovers,
 * so "nothing sent *this* pass" must not mark a campaign failed when
 * 800 of its 1 000 recipients went out earlier. `failed` means every
 * single recipient failed; anything else that reached Meta is `sent`,
 * with the per-recipient failures visible in `failed_count`.
 *
 * Per-status counts stay trigger-owned (migrations 003/005) — only the
 * terminal `status` is written here.
 */
export async function finalizeBroadcastStatus(
  db: SupabaseClient,
  broadcastId: string
): Promise<void> {
  const countWhere = async (status: string): Promise<number> => {
    const { count } = await db
      .from('broadcast_recipients')
      .select('id', { count: 'exact', head: true })
      .eq('broadcast_id', broadcastId)
      .eq('status', status);
    return count ?? 0;
  };

  // Still work outstanding (a capped resume pass) — leave it 'sending'
  // so the UI keeps offering Resume.
  if ((await countWhere('pending')) > 0) return;

  const failed = await countWhere('failed');
  const { count: total } = await db
    .from('broadcast_recipients')
    .select('id', { count: 'exact', head: true })
    .eq('broadcast_id', broadcastId);

  await db
    .from('broadcasts')
    .update({
      status: failed > 0 && failed === (total ?? 0) ? 'failed' : 'sent',
      updated_at: new Date().toISOString(),
    })
    .eq('id', broadcastId);
}
