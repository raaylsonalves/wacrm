// ============================================================
// Web Push sending (specs/pwa-web-push-notifications.md).
//
// Server-only. Called from both inbound webhooks' `after()` fan-out:
// a closed tab has no Realtime socket, so the only way to reach it is
// a push that originates here, at the moment the message has landed.
//
// Missing VAPID env degrades to "push disabled" — the tab-open
// Realtime alert (use-browser-notifications.ts) keeps working.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import webpush, { WebPushError } from 'web-push';

import {
  DEFAULT_NOTIFICATION_LABELS,
  buildNotificationContent,
  conversationHref,
  pickContactDisplayName,
  type NotifiableMessage,
  type NotificationLabels,
} from '@/lib/notifications/browser-notify';
import { accountNotificationIcon } from '@/lib/branding/pwa-branding';

export interface PushPayload {
  title: string;
  body: string;
  /** Doubles as the notification `tag` — one alert per conversation. */
  conversationId: string;
  url: string;
  /** Account-branded icon; the service worker falls back to the default. */
  icon?: string;
}

export interface VapidConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
}

export function getVapidConfig(
  env: Record<string, string | undefined> = process.env
): VapidConfig | null {
  const publicKey = env.NEXT_PUBLIC_VAPID_PUBLIC_KEY?.trim();
  const privateKey = env.VAPID_PRIVATE_KEY?.trim();
  const subject = env.VAPID_SUBJECT?.trim();
  if (!publicKey || !privateKey || !subject) return null;
  return { publicKey, privateKey, subject };
}

export interface SubscriptionRow {
  id: string;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth_key: string;
}

/** Sends one push; throws on failure (web-push's own contract). */
export type PushSender = (
  sub: SubscriptionRow,
  payload: string
) => Promise<void>;

/**
 * 404/410 from the push service mean the subscription is permanently
 * gone (browser unsubscribed, endpoint expired). Anything else — 429,
 * 5xx, network — is transient and keeps the row.
 */
export function isGoneError(err: unknown): boolean {
  const status =
    err instanceof WebPushError
      ? err.statusCode
      : (err as { statusCode?: unknown } | null)?.statusCode;
  return status === 404 || status === 410;
}

/**
 * Who gets pushed for a conversation: its assignee alone when it has
 * one (everyone else's phone buzzing for a thread someone owns is
 * noise), otherwise every subscribed member of the account.
 */
export function pushRecipientFilter(
  assignedAgentId: string | null | undefined
): (row: SubscriptionRow) => boolean {
  if (!assignedAgentId) return () => true;
  return (row) => row.user_id === assignedAgentId;
}

export interface SendResult {
  sent: number;
  removed: number;
  failed: number;
}

export async function sendPushToAccount(
  db: SupabaseClient,
  accountId: string,
  payload: PushPayload,
  opts: {
    onlyUserId?: string | null;
    sender?: PushSender;
    vapid?: VapidConfig | null;
  } = {}
): Promise<SendResult> {
  const result: SendResult = { sent: 0, removed: 0, failed: 0 };
  const vapid = opts.vapid !== undefined ? opts.vapid : getVapidConfig();
  if (!vapid && !opts.sender) return result;

  const { data, error } = await db
    .from('push_subscriptions')
    .select('id, user_id, endpoint, p256dh, auth_key')
    .eq('account_id', accountId);
  if (error || !data || data.length === 0) return result;

  const rows = (data as SubscriptionRow[]).filter(
    pushRecipientFilter(opts.onlyUserId)
  );
  if (rows.length === 0) return result;

  const sender = opts.sender ?? webPushSender(vapid!);
  const body = JSON.stringify(payload);
  const gone: string[] = [];

  await Promise.all(
    rows.map(async (row) => {
      try {
        await sender(row, body);
        result.sent++;
      } catch (err) {
        if (isGoneError(err)) {
          gone.push(row.id);
        } else {
          result.failed++;
          console.warn(
            '[push] send failed:',
            err instanceof Error ? err.message : err
          );
        }
      }
    })
  );

  if (gone.length > 0) {
    const { error: delError } = await db
      .from('push_subscriptions')
      .delete()
      .in('id', gone);
    if (delError) {
      console.error(
        '[push] failed to prune gone subscriptions:',
        delError.message
      );
    } else {
      result.removed = gone.length;
    }
  }

  return result;
}

function webPushSender(vapid: VapidConfig): PushSender {
  return async (sub, payload) => {
    await webpush.sendNotification(
      {
        endpoint: sub.endpoint,
        keys: { p256dh: sub.p256dh, auth: sub.auth_key },
      },
      payload,
      {
        vapidDetails: {
          subject: vapid.subject,
          publicKey: vapid.publicKey,
          privateKey: vapid.privateKey,
        },
        // A message alert that arrives a day late is worse than none.
        TTL: 60 * 60,
        urgency: 'high',
      }
    );
  };
}

/**
 * Labels in the deployment's locale — notifications aren't React-
 * rendered, so read the same dictionary src/i18n/request.ts loads.
 */
async function loadLabels(): Promise<NotificationLabels> {
  const locale = process.env.NEXT_PUBLIC_APP_LOCALE || 'en';
  try {
    const messages = (await import(`../../../messages/${locale}.json`)).default;
    const l = messages?.Settings?.browserNotifications?.labels;
    return l
      ? { ...DEFAULT_NOTIFICATION_LABELS, ...l }
      : DEFAULT_NOTIFICATION_LABELS;
  } catch {
    return DEFAULT_NOTIFICATION_LABELS;
  }
}

/**
 * Webhook entry point: build the alert for one inbound message and push
 * it. Never throws — it runs inside `after()` next to the other
 * fire-and-forget fan-out consumers.
 */
export async function pushInboundMessage(
  db: SupabaseClient,
  accountId: string,
  message: NotifiableMessage
): Promise<void> {
  try {
    if (message.sender_type !== 'customer') return;
    if (!getVapidConfig()) return;

    const { data: conv } = await db
      .from('conversations')
      .select('assigned_agent_id, contact:contacts(name, wa_username, phone)')
      .eq('id', message.conversation_id)
      .eq('account_id', accountId)
      .maybeSingle();
    if (!conv) return;

    const rawContact = (conv as { contact?: unknown }).contact;
    const contact = (Array.isArray(rawContact) ? rawContact[0] : rawContact) as
      | {
          name?: string | null;
          wa_username?: string | null;
          phone?: string | null;
        }
      | null
      | undefined;

    const { title, body } = buildNotificationContent(
      message,
      pickContactDisplayName(contact),
      await loadLabels()
    );

    await sendPushToAccount(
      db,
      accountId,
      {
        title,
        body,
        conversationId: message.conversation_id,
        url: conversationHref(message.conversation_id),
        icon: await accountNotificationIcon(accountId),
      },
      {
        onlyUserId: (conv as { assigned_agent_id?: string | null })
          .assigned_agent_id,
      }
    );
  } catch (err) {
    console.error(
      '[push] pushInboundMessage failed:',
      err instanceof Error ? err.message : err
    );
  }
}
