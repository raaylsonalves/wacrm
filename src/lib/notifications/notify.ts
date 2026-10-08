// ============================================================
// Server-side notifications (migration 086).
//
// One write path for every in-app notification: the `upsert_notification`
// RPC, which applies the user's in-app preference and folds a new event
// into the unread row of the same `groupKey` ("Ana sent 3 messages").
// Push goes out right away for the events written here; rows written by
// DB triggers (assignment, deals, channel, templates, broadcasts) are
// pushed by `dispatchPendingPushes`, run from the cron.
//
// Never throws — every caller is a fire-and-forget side effect of
// something more important (a webhook, a hand-off, the cron).
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import { createTranslator } from 'next-intl';
import { sendPushToAccount } from '@/lib/push/send';
import {
  renderNotification,
  type RenderableNotification,
  type Translate,
} from './render';

export type NotificationType =
  | 'conversation_assigned'
  | 'customer_replied'
  | 'handoff_waiting'
  | 'sla_breached'
  | 'new_unassigned'
  | 'case_opened'
  | 'case_lead_replied'
  | 'case_relay_failed'
  | 'appointment_reminder'
  | 'deal_won'
  | 'deal_lost'
  | 'deal_stage_changed'
  | 'channel_disconnected'
  | 'ai_provider_failed'
  | 'template_status'
  | 'broadcast_finished'
  | 'calendar_disconnected'
  | 'followup_no_reply';

export interface NotifyArgs {
  accountId: string;
  userIds: string[];
  type: NotificationType;
  conversationId?: string | null;
  contactId?: string | null;
  contactName?: string | null;
  title?: string | null;
  body?: string | null;
  data?: Record<string, unknown> | null;
  link: string;
  groupKey?: string | null;
}

/** The deployment locale's translator for the Notifications namespace. */
async function translator(): Promise<Translate> {
  const locale = process.env.NEXT_PUBLIC_APP_LOCALE || 'en';
  let messages: Record<string, unknown>;
  try {
    messages = (await import(`../../../messages/${locale}.json`)).default;
  } catch {
    messages = (await import('../../../messages/en.json')).default;
  }
  // Keys are built at runtime (per type), so drop next-intl's literal-key typing.
  return createTranslator({
    locale,
    messages,
    namespace: 'Notifications',
  }) as unknown as Translate;
}

/**
 * Users (of `userIds`) whose push preference for `type` is on — their
 * row, else the catalogue default.
 */
export async function pushEnabledUsers(
  db: SupabaseClient,
  userIds: string[],
  type: NotificationType
): Promise<string[]> {
  if (userIds.length === 0) return [];
  const [{ data: def }, { data: prefs }] = await Promise.all([
    db
      .from('notification_types')
      .select('push_default')
      .eq('type', type)
      .maybeSingle(),
    db
      .from('notification_preferences')
      .select('user_id, push')
      .eq('type', type)
      .in('user_id', userIds),
  ]);
  const fallback =
    (def as { push_default?: boolean } | null)?.push_default ?? true;
  const byUser = new Map(
    ((prefs ?? []) as { user_id: string; push: boolean }[]).map((p) => [
      p.user_id,
      p.push,
    ])
  );
  return userIds.filter((u) => byUser.get(u) ?? fallback);
}

export async function notifyUsers(
  db: SupabaseClient,
  args: NotifyArgs
): Promise<void> {
  try {
    const users = [...new Set(args.userIds.filter(Boolean))];
    if (users.length === 0) return;

    const ids: string[] = [];
    for (const user of users) {
      const { data, error } = await db.rpc('upsert_notification', {
        p_account: args.accountId,
        p_user: user,
        p_type: args.type,
        p_conversation: args.conversationId ?? null,
        p_contact: args.contactId ?? null,
        p_actor: null,
        p_actor_name: null,
        p_contact_name: args.contactName ?? null,
        p_title: args.title ?? null,
        p_body: args.body ?? null,
        p_data: args.data ?? null,
        p_link: args.link,
        p_group_key: args.groupKey ?? null,
      });
      if (error) console.warn('[notify] upsert failed:', error.message);
      else if (data) ids.push(data as string);
    }

    const pushTo = await pushEnabledUsers(db, users, args.type);
    if (pushTo.length > 0) {
      const t = await translator();
      const text = renderNotification(
        {
          type: args.type,
          contact_name: args.contactName ?? null,
          actor_name: null,
          title: args.title ?? null,
          body: args.body ?? null,
          data: args.data ?? null,
          count: 1,
        },
        t
      );
      for (const user of pushTo) {
        await sendPushToAccount(
          db,
          args.accountId,
          {
            title: text.title.slice(0, 120),
            body: (text.body ?? '').slice(0, 200),
            conversationId: args.groupKey ?? args.conversationId ?? args.type,
            url: args.link,
          },
          { onlyUserId: user }
        );
      }
    }
    if (ids.length > 0) {
      await db
        .from('notifications')
        .update({ pushed_at: new Date().toISOString() })
        .in('id', ids);
    }
  } catch (err) {
    console.warn('[notify] failed:', err instanceof Error ? err.message : err);
  }
}

/**
 * Who hears about a conversation: its assignee; else the channel's routing
 * responsibles; else every agent and above. Mirrors the SQL
 * `notification_team_for` used by the triggers.
 */
export async function teamForConversation(
  db: SupabaseClient,
  accountId: string,
  conversationId: string
): Promise<string[]> {
  const { data: conv } = await db
    .from('conversations')
    .select('assigned_agent_id, whatsapp_channel_id')
    .eq('id', conversationId)
    .eq('account_id', accountId)
    .maybeSingle();
  if (conv?.assigned_agent_id) return [conv.assigned_agent_id as string];
  return teamForChannel(
    db,
    accountId,
    (conv?.whatsapp_channel_id as string | null) ?? null
  );
}

export async function teamForChannel(
  db: SupabaseClient,
  accountId: string,
  channelId: string | null
): Promise<string[]> {
  let policy = db
    .from('channel_routing_policies')
    .select('id')
    .eq('account_id', accountId);
  policy = channelId
    ? policy.eq('waha_channel_id', channelId)
    : policy.is('waha_channel_id', null);
  const { data: pol } = await policy.maybeSingle();
  if (pol?.id) {
    const { data: resp } = await db
      .from('channel_routing_responsibles')
      .select('user_id')
      .eq('policy_id', pol.id);
    const ids = (resp ?? []).map((r) => r.user_id as string);
    if (ids.length > 0) return ids;
  }
  const { data: members } = await db
    .from('profiles')
    .select('user_id')
    .eq('account_id', accountId)
    .in('account_role', ['owner', 'admin', 'agent']);
  return (members ?? []).map((m) => m.user_id as string);
}

export async function adminsFor(
  db: SupabaseClient,
  accountId: string
): Promise<string[]> {
  const { data } = await db
    .from('profiles')
    .select('user_id')
    .eq('account_id', accountId)
    .in('account_role', ['owner', 'admin']);
  return (data ?? []).map((m) => m.user_id as string);
}

/**
 * Cron: push the notifications DB triggers wrote (assignment, deals,
 * channel, templates, broadcasts) — the triggers can't reach the push
 * service themselves. Each row is claimed by stamping `pushed_at`, so a
 * row is pushed at most once even if two cron runs overlap.
 */
export async function dispatchPendingPushes(
  db: SupabaseClient
): Promise<{ scanned: number; pushed: number }> {
  const result = { scanned: 0, pushed: 0 };
  try {
    const since = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const { data: rows } = await db
      .from('notifications')
      .select(
        'id, account_id, user_id, type, contact_name, actor_name, title, body, data, count, link, conversation_id'
      )
      .is('pushed_at', null)
      .is('read_at', null)
      .gte('created_at', since)
      .order('created_at', { ascending: true })
      .limit(200);
    if (!rows || rows.length === 0) return result;
    result.scanned = rows.length;

    const ids = rows.map((r) => r.id as string);
    const { data: claimed } = await db
      .from('notifications')
      .update({ pushed_at: new Date().toISOString() })
      .in('id', ids)
      .is('pushed_at', null)
      .select('id');
    const mine = new Set((claimed ?? []).map((r) => r.id as string));
    const t = await translator();

    for (const row of rows) {
      if (!mine.has(row.id as string)) continue;
      const type = row.type as NotificationType;
      const allowed = await pushEnabledUsers(db, [row.user_id as string], type);
      if (allowed.length === 0) continue;
      const text = renderNotification(
        row as unknown as RenderableNotification,
        t
      );
      await sendPushToAccount(
        db,
        row.account_id as string,
        {
          title: text.title.slice(0, 120),
          body: (text.body ?? '').slice(0, 200),
          conversationId:
            (row.conversation_id as string | null) ?? (row.id as string),
          url: (row.link as string | null) ?? '/notifications',
        },
        { onlyUserId: row.user_id as string }
      );
      result.pushed++;
    }
  } catch (err) {
    console.warn(
      '[notify] push dispatch failed:',
      err instanceof Error ? err.message : err
    );
  }
  return result;
}
