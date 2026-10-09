// ============================================================
// The silence sweep (specs/followup-sequences.md §2).
//
// Called from GET /api/automations/cron, so a deployment needs no second
// pinger. For each active `conversation_silence` automation it finds
// conversations where WE spoke last and the customer has been quiet past
// the configured silence, enrolls each one exactly once per episode, and
// starts the sequence.
//
// Never throws — same contract as runAutomationsForTrigger.
// ============================================================

import type { Automation } from '@/types'
import { supabaseAdmin } from './admin-client'
import { startFollowupRun } from './engine'
import {
  decideExhaust,
  parseSilenceConfig,
  sweepBounds,
  type SilenceConfig,
} from './followup-logic'
import { notifyUsers, teamForConversation } from '@/lib/notifications/notify'

/** Bounded per automation per run, oldest first: a backlog drains over a
 *  few cron ticks instead of one run texting hundreds of people at once. */
const BATCH_LIMIT = 200

export interface SweepResult {
  automations: number
  enrolled: number
  /** Exhausted sequences whose "no reply" actions ran this tick. */
  exhausted: number
}

export async function runFollowupSweep(now: Date = new Date()): Promise<SweepResult> {
  const result: SweepResult = { automations: 0, enrolled: 0, exhausted: 0 }
  try {
    const db = supabaseAdmin()
    const { data: automations, error } = await db
      .from('automations')
      .select('*')
      .eq('trigger_type', 'conversation_silence')
      .eq('is_active', true)
    if (error) {
      console.error('[followup] sweep: automations fetch failed:', error.message)
      return result
    }

    for (const automation of (automations ?? []) as Automation[]) {
      try {
        result.enrolled += await sweepOne(automation, now)
        result.automations++
      } catch (err) {
        console.error('[followup] sweep failed for automation', automation.id, err)
      }
      try {
        result.exhausted += await handleExhausted(automation, now)
      } catch (err) {
        console.error('[followup] sweep failed for automation', automation.id, err)
      }
    }
  } catch (err) {
    console.error('[followup] sweep failed:', err)
  }
  return result
}

async function sweepOne(automation: Automation, now: Date): Promise<number> {
  const cfg = parseSilenceConfig(automation.trigger_config)
  if (!cfg) return 0 // half-edited: skipped, never run with a guessed silence

  const db = supabaseAdmin()
  const { silentBefore, notOlderThan } = sweepBounds(cfg, now)

  let query = db
    .from('conversations')
    .select('id, contact_id, last_customer_message_at, snoozed_until')
    .eq('account_id', automation.account_id)
    .in('status', ['open', 'pending'])
    // We spoke last: waiting on the customer, not the other way round
    // (that is the response-time SLA — a different problem, other owner).
    .in('last_message_sender_type', ['agent', 'bot'])
    // Never follow up someone who never wrote to us — that is cold
    // outreach, which has its own consent rules.
    .not('last_customer_message_at', 'is', null)
    .lte('last_message_at', silentBefore.toISOString())
    .gte('last_message_at', notOlderThan.toISOString())
    .order('last_message_at', { ascending: true })
    .limit(BATCH_LIMIT)

  if (cfg.handoff_policy === 'cancel') query = query.is('assigned_agent_id', null)
  if (cfg.audience === 'ai_conversations') {
    query = query.is('assigned_agent_id', null).eq('ai_autoreply_disabled', false)
  }

  const { data: conversations, error } = await query
  if (error) throw new Error(`conversation scan failed: ${error.message}`)
  const candidates = (conversations ?? []).filter(
    (c) => !c.snoozed_until || new Date(c.snoozed_until as string) <= now
  )
  if (candidates.length === 0) return 0

  // Opted-out contacts never enter a sequence.
  const contactIds = [...new Set(candidates.map((c) => c.contact_id as string))]
  const { data: optedOut } = await db
    .from('contacts')
    .select('id')
    .eq('account_id', automation.account_id)
    .in('id', contactIds)
    .not('opted_out_at', 'is', null)
  const blocked = new Set((optedOut ?? []).map((c) => c.id as string))

  let enrolled = 0
  for (const conv of candidates) {
    if (blocked.has(conv.contact_id as string)) continue

    // The unique key IS the claim: a returned row means THIS run won it.
    // ignoreDuplicates → ON CONFLICT DO NOTHING, so two overlapping
    // sweeps (or a second tick before the first finished) can't both
    // start the same episode.
    const { data: claimed, error: claimErr } = await db
      .from('followup_enrollments')
      .upsert(
        {
          account_id: automation.account_id,
          automation_id: automation.id,
          conversation_id: conv.id,
          contact_id: conv.contact_id,
          episode_at: conv.last_customer_message_at,
        },
        { onConflict: 'automation_id,conversation_id,episode_at', ignoreDuplicates: true }
      )
      .select('id')
    if (claimErr) {
      console.error('[followup] enroll failed:', claimErr.message)
      continue
    }
    const enrollmentId = claimed?.[0]?.id as string | undefined
    if (!enrollmentId) continue // already enrolled for this episode

    enrolled++
    try {
      await startFollowupRun(automation, {
        contactId: conv.contact_id as string,
        conversationId: conv.id as string,
        enrollmentId,
      })
    } catch (err) {
      console.error('[followup] run failed:', automation.id, conv.id, err)
    }
  }
  return enrolled
}

/**
 * Sequences that ran out of steps (outcome `exhausted`): once the last one
 * has had a full silence interval to be answered, run the automation's
 * `on_exhaust` actions — notify the team, hand over, tag, close
 * (migration 115). Claimed through `exhaust_handled_at`, so each
 * enrollment is handled once even with overlapping sweeps.
 */
async function handleExhausted(automation: Automation, now: Date): Promise<number> {
  const cfg = parseSilenceConfig(automation.trigger_config)
  if (!cfg) return 0
  const db = supabaseAdmin()

  const { data: pending, error } = await db
    .from('followup_enrollments')
    .select('id, conversation_id, contact_id, episode_at, ended_at, steps_sent')
    .eq('automation_id', automation.id)
    .eq('outcome', 'exhausted')
    .is('exhaust_handled_at', null)
    .order('ended_at', { ascending: true })
    .limit(BATCH_LIMIT)
  if (error) throw new Error(`exhausted scan failed: ${error.message}`)

  let handled = 0
  for (const e of pending ?? []) {
    if (!e.ended_at) continue
    const { data: conv } = await db
      .from('conversations')
      .select('id, last_customer_message_at, status')
      .eq('id', e.conversation_id)
      .eq('account_id', automation.account_id)
      .maybeSingle()
    const verdict = conv
      ? decideExhaust({
          episodeAt: new Date(e.episode_at as string),
          lastCustomerMessageAt: conv.last_customer_message_at
            ? new Date(conv.last_customer_message_at as string)
            : null,
          endedAt: new Date(e.ended_at as string),
          now,
          cfg,
        })
      : 'replied' // conversation gone: nothing left to act on
    if (verdict === 'wait') continue

    // The claim: only the run that flips it acts.
    const { data: claimed } = await db
      .from('followup_enrollments')
      .update({ exhaust_handled_at: now.toISOString() })
      .eq('id', e.id)
      .is('exhaust_handled_at', null)
      .select('id')
    if (!claimed || claimed.length === 0 || verdict === 'replied') continue

    try {
      await runExhaustActions(automation, cfg, {
        conversationId: e.conversation_id as string,
        contactId: e.contact_id as string,
        stepsSent: (e.steps_sent as number | null) ?? 0,
      })
      handled++
    } catch (err) {
      console.error('[followup] exhaust actions failed:', automation.id, e.id, err)
    }
  }
  return handled
}

async function runExhaustActions(
  automation: Automation,
  cfg: SilenceConfig,
  t: { conversationId: string; contactId: string; stepsSent: number }
): Promise<void> {
  const db = supabaseAdmin()
  const actions = cfg.on_exhaust
  const accountId = automation.account_id

  // Who to tell is decided BEFORE a handoff/close changes the thread.
  // A handoff always tells someone: stepping the AI out with nobody told
  // would strand the conversation (review 2026-10, A12).
  const team =
    actions.notify || (actions.handoff && !actions.close)
      ? await teamForConversation(db, accountId, t.conversationId)
      : []

  if (actions.tag_id) {
    // Only a tag of this account (the config is user-edited JSON).
    const { data: tag } = await db
      .from('tags')
      .select('id')
      .eq('id', actions.tag_id)
      .eq('account_id', accountId)
      .maybeSingle()
    if (tag) {
      await db
        .from('contact_tags')
        .upsert(
          { contact_id: t.contactId, tag_id: tag.id },
          { onConflict: 'contact_id,tag_id', ignoreDuplicates: true }
        )
    }
  }

  if (actions.close) {
    await db
      .from('conversations')
      .update({ status: 'closed', updated_at: new Date().toISOString() })
      .eq('id', t.conversationId)
      .eq('account_id', accountId)
  } else if (actions.handoff) {
    // The AI steps out; nobody assigned = the "waiting for a person" queue.
    await db
      .from('conversations')
      .update({ ai_autoreply_disabled: true, ai_handoff_reason: 'followup_exhausted' })
      .eq('id', t.conversationId)
      .eq('account_id', accountId)
  }

  if (team.length > 0) {
    const { data: contact } = await db
      .from('contacts')
      .select('name, phone')
      .eq('id', t.contactId)
      .eq('account_id', accountId)
      .maybeSingle()
    await notifyUsers(db, {
      accountId,
      userIds: team,
      type: 'followup_no_reply',
      conversationId: t.conversationId,
      contactId: t.contactId,
      contactName: (contact?.name as string | null) || (contact?.phone as string | null) || null,
      data: { automation: automation.name, steps: t.stepsSent },
      link: `/inbox?c=${t.conversationId}`,
    })
  }
}
