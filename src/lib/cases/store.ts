// ============================================================
// Human cases — the server side (specs/human-cases.md). Service role:
// every query carries the account id; every transition goes through the
// state machine and leaves an event.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { notifyUsers } from '@/lib/notifications/notify'
import {
  MAX_OPEN_PER_CONVERSATION,
  MAX_OPENED_PER_HOUR,
  canTransition,
  type CaseAction,
  type CaseStatus,
} from './state-machine'

export interface CaseRow {
  id: string
  account_id: string
  conversation_id: string
  contact_id: string
  title: string
  summary: string
  blocker: string
  status: CaseStatus
  claimed_by: string | null
  pending_note: string | null
  pending_action: 'done' | 'need_info' | null
  relay_status: 'pending' | 'sent' | 'window_closed' | 'failed' | null
}

const clip = (v: string, n: number) => v.replace(/\s+/g, ' ').trim().slice(0, n)

/** The last messages, as the teammate should see them. Read from the DB,
 *  never from anything the model wrote. */
async function excerptOf(db: SupabaseClient, conversationId: string): Promise<string> {
  const { data } = await db
    .from('messages')
    .select('sender_type, content_type, content_text, transcript')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(8)
  return ((data ?? []) as { sender_type: string; content_type: string; content_text: string | null; transcript: string | null }[])
    .reverse()
    .map((m) => {
      const who = m.sender_type === 'customer' ? 'Cliente' : 'Empresa'
      const text = m.content_type === 'audio' ? (m.transcript ?? '[áudio]') : (m.content_text ?? `[${m.content_type}]`)
      return `${who}: ${clip(text, 400)}`
    })
    .join('\n')
}

/** Who is paged: the number's responsibles when set, else every agent+. */
async function recipientsFor(db: SupabaseClient, accountId: string, conversationId: string): Promise<string[]> {
  const { data: conv } = await db
    .from('conversations')
    .select('whatsapp_channel_id, assigned_agent_id')
    .eq('id', conversationId)
    .maybeSingle()
  if (conv?.assigned_agent_id) return [conv.assigned_agent_id as string]

  let policy = db.from('channel_routing_policies').select('id').eq('account_id', accountId)
  policy = conv?.whatsapp_channel_id
    ? policy.eq('waha_channel_id', conv.whatsapp_channel_id)
    : policy.is('waha_channel_id', null)
  const { data: pol } = await policy.maybeSingle()
  if (pol?.id) {
    const { data: resp } = await db.from('channel_routing_responsibles').select('user_id').eq('policy_id', pol.id)
    const ids = (resp ?? []).map((r) => r.user_id as string)
    if (ids.length > 0) return ids
  }
  const { data: members } = await db
    .from('profiles')
    .select('user_id, account_role')
    .eq('account_id', accountId)
    .in('account_role', ['owner', 'admin', 'agent'])
  return (members ?? []).map((m) => m.user_id as string)
}

export async function notifyTeam(
  db: SupabaseClient,
  args: {
    accountId: string
    conversationId: string
    contactId: string
    type: 'case_opened' | 'case_lead_replied' | 'case_relay_failed'
    title: string
    body: string
  },
): Promise<void> {
  try {
    // notifyUsers applies each person's in-app / push preference.
    await notifyUsers(db, {
      accountId: args.accountId,
      userIds: await recipientsFor(db, args.accountId, args.conversationId),
      type: args.type,
      conversationId: args.conversationId,
      contactId: args.contactId,
      title: clip(args.title, 200),
      body: clip(args.body, 500),
      link: '/cases',
    })
  } catch (err) {
    console.warn('[cases] notify failed:', err)
  }
}

export async function logEvent(
  db: SupabaseClient,
  e: { caseId: string; accountId: string; kind: string; actorKind: 'ai' | 'human' | 'system'; actorUserId?: string | null; body?: string | null },
): Promise<void> {
  await db.from('human_case_events').insert({
    case_id: e.caseId,
    account_id: e.accountId,
    kind: e.kind,
    actor_kind: e.actorKind,
    actor_user_id: e.actorUserId ?? null,
    body: e.body ? clip(e.body, 2000) : null,
  })
}

export type OpenResult =
  | { ok: true; caseId: string }
  | { ok: false; error: 'too_many_open' | 'rate_limited' | 'invalid' | 'failed' }

export async function openCase(
  db: SupabaseClient,
  args: {
    accountId: string
    conversationId: string
    contactId: string
    title: string
    summary: string
    blocker: string
    openedBy: 'ai' | 'system' | 'human'
  },
): Promise<OpenResult> {
  const title = clip(args.title, 120)
  if (!title) return { ok: false, error: 'invalid' }

  const { count: open } = await db
    .from('human_cases')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', args.conversationId)
    .in('status', ['awaiting_human', 'awaiting_lead'])
  if ((open ?? 0) >= MAX_OPEN_PER_CONVERSATION) return { ok: false, error: 'too_many_open' }
  const hourAgo = new Date(Date.now() - 3600_000).toISOString()
  const { count: recent } = await db
    .from('human_cases')
    .select('id', { count: 'exact', head: true })
    .eq('account_id', args.accountId)
    .gte('opened_at', hourAgo)
  if ((recent ?? 0) >= MAX_OPENED_PER_HOUR) return { ok: false, error: 'rate_limited' }

  const { data, error } = await db
    .from('human_cases')
    .insert({
      account_id: args.accountId,
      conversation_id: args.conversationId,
      contact_id: args.contactId,
      title,
      summary: clip(args.summary, 1000),
      blocker: clip(args.blocker, 500),
      excerpt: await excerptOf(db, args.conversationId),
      opened_by: args.openedBy,
    })
    .select('id')
    .single()
  if (error || !data) {
    console.error('[cases] open failed:', error)
    return { ok: false, error: 'failed' }
  }
  const caseId = data.id as string
  await logEvent(db, { caseId, accountId: args.accountId, kind: 'opened', actorKind: args.openedBy, body: args.blocker })
  await notifyTeam(db, {
    accountId: args.accountId,
    conversationId: args.conversationId,
    contactId: args.contactId,
    type: 'case_opened',
    title: `Novo caso: ${title}`,
    body: args.blocker || args.summary,
  })
  return { ok: true, caseId }
}

export async function loadCase(db: SupabaseClient, accountId: string, caseId: string): Promise<CaseRow | null> {
  const { data } = await db
    .from('human_cases')
    .select('id, account_id, conversation_id, contact_id, title, summary, blocker, status, claimed_by, pending_note, pending_action, relay_status')
    .eq('id', caseId)
    .eq('account_id', accountId)
    .maybeSingle()
  return (data as CaseRow | null) ?? null
}

export type TransitionOutcome =
  | { ok: true; noop: boolean; row: CaseRow }
  | { ok: false; error: 'not_found' | 'illegal_transition' | 'failed' }

/**
 * Apply an action. `done` / `need_info` also queue the note for the AI to
 * relay (relay_status = 'pending'); the caller runs the relay. Guarded by
 * the current status in the UPDATE too, so two concurrent clicks can't
 * both win.
 */
export async function transitionCase(
  db: SupabaseClient,
  args: {
    accountId: string
    caseId: string
    action: CaseAction
    actorKind: 'ai' | 'human' | 'system'
    actorUserId?: string | null
    note?: string | null
  },
): Promise<TransitionOutcome> {
  const row = await loadCase(db, args.accountId, args.caseId)
  if (!row) return { ok: false, error: 'not_found' }
  const t = canTransition(row.status, args.action)
  if (!t.ok) return { ok: false, error: 'illegal_transition' }
  if ('noop' in t) return { ok: true, noop: true, row }

  const note = args.note ? clip(args.note, 1000) : null
  const relay = args.action === 'done' || args.action === 'need_info'
  const now = new Date().toISOString()
  const { data: updated, error } = await db
    .from('human_cases')
    .update({
      status: t.to,
      updated_at: now,
      ...(t.to === 'resolved' || t.to === 'cancelled' || t.to === 'escalated' ? { resolved_at: now } : {}),
      ...(relay ? { pending_note: note, pending_action: args.action, relay_status: 'pending' } : {}),
      ...(args.actorUserId && args.actorKind === 'human' && !row.claimed_by ? { claimed_by: args.actorUserId } : {}),
    })
    .eq('id', row.id)
    .eq('status', row.status)
    .select('id')
  if (error) return { ok: false, error: 'failed' }
  if (!updated || updated.length === 0) return { ok: true, noop: true, row }

  await logEvent(db, {
    caseId: row.id,
    accountId: args.accountId,
    kind: args.action,
    actorKind: args.actorKind,
    actorUserId: args.actorUserId,
    body: note,
  })
  return { ok: true, noop: false, row: { ...row, status: t.to } }
}
