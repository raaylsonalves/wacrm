// ============================================================
// One prospecting tick (called by the automations cron). For each running
// campaign whose turn has come, at most ONE message goes out: a due
// follow-up to someone who didn't reply, otherwise the next new lead.
// Only inside the sending window, under the daily cap (first touches and
// follow-ups together) and, on WAHA, the warm-up ceiling. Anything
// "not yet" just moves next_send_at.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { loadAiConfig } from '@/lib/ai/config'
import { generateReplyWithFallback } from '@/lib/ai/generate-with-fallback'
import { logAiUsage } from '@/lib/ai/usage'
import { AiError } from '@/lib/ai/types'
import { sendMessageToConversation, SendMessageError } from '@/lib/whatsapp/send-message'
import { prepareCandidate } from './activate'
import {
  buildApproachPrompt,
  buildFollowupPrompt,
  failureScope,
  followupCutoff,
  isInSendingWindow,
  nextSendAt,
  nextWindowOpening,
  optOutLine,
  renderTemplateParams,
  warmupCeiling,
  type CampaignConfig,
} from './logic'

interface CampaignRow {
  id: string
  account_id: string
  name: string
  config: CampaignConfig
  next_send_at: string
}

interface CandidateRow {
  id: string
  contact_id: string
  conversation_id: string | null
  deal_id: string | null
  sent_at: string | null
  followups_sent: number
}

export interface TickSummary {
  campaigns: number
  sent: number
  followups: number
  failed: number
  paused: number
}

export async function runProspectingTick(
  now: Date = new Date(),
  /** Just this campaign — the first pass right after start/resume. */
  opts: { campaignId?: string } = {},
): Promise<TickSummary> {
  const db = supabaseAdmin()
  const summary: TickSummary = { campaigns: 0, sent: 0, followups: 0, failed: 0, paused: 0 }
  let q = db
    .from('prospecting_campaigns')
    .select('id, account_id, name, config, next_send_at')
    .eq('status', 'running')
    .lte('next_send_at', now.toISOString())
  if (opts.campaignId) q = q.eq('id', opts.campaignId)
  const { data } = await q.limit(50)

  for (const c of (data ?? []) as CampaignRow[]) {
    summary.campaigns++
    try {
      const r = await tickCampaign(db, c, now)
      if (r === 'sent') summary.sent++
      if (r === 'followup') summary.followups++
      if (r === 'failed') summary.failed++
      if (r === 'paused') summary.paused++
    } catch (err) {
      console.error(`[prospecting ${c.id}] tick failed:`, err)
    }
  }
  return summary
}

type TickResult = 'waiting' | 'sent' | 'followup' | 'failed' | 'paused' | 'completed'

async function tickCampaign(db: SupabaseClient, c: CampaignRow, now: Date): Promise<TickResult> {
  const cfg = c.config
  const tag = `[prospecting ${c.id}]`
  const stamp = now.toISOString()
  const reschedule = (at: Date) =>
    db.from('prospecting_campaigns').update({ next_send_at: at.toISOString(), updated_at: stamp }).eq('id', c.id)
  const pause = async (error: string) => {
    await db.from('prospecting_campaigns').update({ status: 'paused', error, updated_at: stamp }).eq('id', c.id)
    console.warn(`${tag} paused: ${error}`)
    return 'paused' as const
  }

  // Claim this turn: only the pass that moves next_send_at off the value
  // it read gets to send. Two overlapping passes (the cron and the kick
  // on start/resume, or two cron hits) would otherwise both send the same
  // cold message. The lease is short; the real next time is set below.
  const { data: turn } = await db
    .from('prospecting_campaigns')
    .update({ next_send_at: new Date(now.getTime() + 120_000).toISOString() })
    .eq('id', c.id)
    .eq('status', 'running')
    .eq('next_send_at', c.next_send_at)
    .select('id')
  if (!turn || turn.length === 0) return 'waiting'

  if (!isInSendingWindow(now, cfg)) {
    await reschedule(nextWindowOpening(now, cfg))
    return 'waiting'
  }

  let connectedAt: string | null = null
  if (cfg.channel_kind === 'waha') {
    const { data: ch } = await db
      .from('whatsapp_waha_channels')
      .select('status, connected_at')
      .eq('id', cfg.channel_id!)
      .eq('account_id', c.account_id)
      .maybeSingle()
    if (!ch) return pause('channel_missing')
    if (ch.status !== 'connected') return pause('channel_disconnected')
    connectedAt = ch.connected_at
  }

  // Daily cap across ALL of the account's cold sends (first touches and
  // follow-ups), not per campaign. A failed attempt still counts: the
  // quota is spent whether or not the send was confirmed.
  const dayAgo = new Date(now.getTime() - 86_400_000).toISOString()
  const { count: touched } = await db
    .from('prospecting_candidates')
    .select('id', { count: 'exact', head: true })
    .eq('account_id', c.account_id)
    .or(`attempted_at.gte.${dayAgo},last_touch_at.gte.${dayAgo}`)
  const cap = Math.min(cfg.daily_limit, warmupCeiling(cfg.channel_kind, connectedAt, now))
  if ((touched ?? 0) >= cap) {
    await reschedule(new Date(now.getTime() + 3600_000))
    return 'waiting'
  }

  const agent =
    cfg.channel_kind === 'waha' || cfg.followup_enabled
      ? await loadAiConfig(db, c.account_id, { agentId: cfg.agent_id })
      : null
  if (cfg.channel_kind === 'waha' && !agent) return pause('agent_missing')

  // 1) A due follow-up first: warmer than a stranger.
  if (cfg.followup_enabled) {
    const { data: due } = await db
      .from('prospecting_candidates')
      .select('id, contact_id, conversation_id, deal_id, sent_at, followups_sent')
      .eq('campaign_id', c.id)
      .eq('status', 'sent')
      .is('replied_at', null)
      .is('opted_out_at', null)
      .lt('followups_sent', cfg.followup_max)
      .lte('last_touch_at', followupCutoff(now, cfg.followup_after_days).toISOString())
      .order('last_touch_at', { ascending: true })
      .limit(1)
    const cand = (due as CandidateRow[] | null)?.[0]
    if (cand) {
      // Claim: only one tick may send this touch.
      const { data: claimed } = await db
        .from('prospecting_candidates')
        .update({ followups_sent: cand.followups_sent + 1, last_touch_at: stamp })
        .eq('id', cand.id)
        .eq('followups_sent', cand.followups_sent)
        .select('id')
      if (claimed && claimed.length > 0) {
        return sendTouch(db, { c, cand, agent, now, touch: cand.followups_sent + 1, reschedule, pause })
      }
    }
  }

  // 2) The next new lead.
  const { data: claimed } = await db.rpc('claim_prospecting_candidate', { p_campaign_id: c.id })
  const cand = (claimed as CandidateRow[] | null)?.[0]
  if (!cand) {
    // Nothing queued. Keep running while follow-ups may still be due.
    if (cfg.followup_enabled) {
      const { count: pending } = await db
        .from('prospecting_candidates')
        .select('id', { count: 'exact', head: true })
        .eq('campaign_id', c.id)
        .eq('status', 'sent')
        .is('replied_at', null)
        .is('opted_out_at', null)
        .lt('followups_sent', cfg.followup_max)
      if ((pending ?? 0) > 0) {
        await reschedule(new Date(now.getTime() + 3600_000))
        return 'waiting'
      }
    }
    await db.from('prospecting_campaigns').update({ status: 'completed', updated_at: stamp }).eq('id', c.id)
    return 'completed'
  }

  if (!cand.conversation_id || !cand.deal_id) {
    const prep = await prepareCandidate(db, {
      accountId: c.account_id,
      campaignName: c.name,
      candidateId: cand.id,
      contactId: cand.contact_id,
      config: cfg,
    })
    if (!prep.ok) {
      await db.from('prospecting_candidates').update({ status: 'skipped', error: prep.reason }).eq('id', cand.id)
      await reschedule(now)
      return 'waiting'
    }
    cand.conversation_id = prep.conversationId
    cand.deal_id = prep.dealId
  }
  return sendTouch(db, { c, cand, agent, now, touch: 0, reschedule, pause })
}

/** touch 0 = first message; 1..n = follow-ups. */
async function sendTouch(
  db: SupabaseClient,
  args: {
    c: CampaignRow
    cand: CandidateRow
    agent: Awaited<ReturnType<typeof loadAiConfig>>
    now: Date
    touch: number
    reschedule: (at: Date) => PromiseLike<unknown>
    pause: (error: string) => Promise<'paused'>
  },
): Promise<TickResult> {
  const { c, cand, agent, now, touch } = args
  const cfg = c.config
  const tag = `[prospecting ${c.id}]`
  const isFollowup = touch > 0

  const { data: contact } = await db
    .from('contacts')
    .select('name, company, opted_out_at')
    .eq('id', cand.contact_id)
    .eq('account_id', c.account_id)
    .maybeSingle()
  const { data: conv } = await db
    .from('conversations')
    .select('assigned_agent_id')
    .eq('id', cand.conversation_id!)
    .maybeSingle()
  // Opted out, or a person took the conversation: never write to them.
  if (!contact || contact.opted_out_at || conv?.assigned_agent_id) {
    await db
      .from('prospecting_candidates')
      .update(isFollowup ? { followups_sent: cfg.followup_max } : { status: 'skipped', error: 'opted_out' })
      .eq('id', cand.id)
    await args.reschedule(now)
    return 'waiting'
  }
  if (isFollowup) {
    // Any reply at all (even after the 72h attribution window) ends the nudging.
    const { count } = await db
      .from('messages')
      .select('id', { count: 'exact', head: true })
      .eq('conversation_id', cand.conversation_id!)
      .eq('sender_type', 'customer')
    if ((count ?? 0) > 0) {
      await db.from('prospecting_candidates').update({ followups_sent: cfg.followup_max }).eq('id', cand.id)
      await args.reschedule(now)
      return 'waiting'
    }
  }

  const fields = { name: contact.name as string | null, company: contact.company as string | null }
  try {
    let result
    if (cfg.channel_kind === 'waha') {
      let previous: string | null = null
      if (isFollowup) {
        const { data: last } = await db
          .from('messages')
          .select('content_text')
          .eq('conversation_id', cand.conversation_id!)
          .neq('sender_type', 'customer')
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle()
        previous = (last?.content_text as string | null) ?? null
      }
      const generation = await generateReplyWithFallback({
        config: agent!,
        systemPrompt: isFollowup
          ? buildFollowupPrompt({
              instruction: cfg.instruction,
              contact: fields,
              previous,
              touch,
              businessContext: agent!.systemPrompt,
            })
          : buildApproachPrompt({
              instruction: cfg.instruction,
              criteria: cfg.criteria,
              contact: fields,
              businessContext: agent!.systemPrompt,
            }),
        messages: [{ role: 'user', content: 'Write the message now.' }],
      })
      void logAiUsage(db, {
        accountId: c.account_id,
        conversationId: cand.conversation_id,
        agentId: cfg.agent_id,
        mode: 'auto_reply',
        provider: generation.provider,
        model: generation.model,
        usage: generation.usage,
      })
      const text = generation.text.trim()
      if (!text || generation.handoff) throw new AiError('The model wrote no message.', { code: 'empty_reply' })
      result = await sendMessageToConversation(db, c.account_id, {
        conversationId: cand.conversation_id!,
        messageType: 'text',
        contentText: `${text}\n\n${optOutLine(process.env.NEXT_PUBLIC_APP_LOCALE)}`,
      })
    } else {
      result = await sendMessageToConversation(db, c.account_id, {
        conversationId: cand.conversation_id!,
        messageType: 'template',
        templateName: isFollowup ? cfg.followup_template_name : cfg.template_name,
        templateLanguage: isFollowup ? cfg.followup_template_language : cfg.template_language,
        templateParams: renderTemplateParams(
          isFollowup ? cfg.followup_template_params : cfg.template_params,
          fields,
        ),
      })
    }

    await db
      .from('messages')
      .update({ sender_type: 'bot', ai_generated: cfg.channel_kind === 'waha' })
      .eq('id', result.messageId)
    if (!isFollowup) {
      const at = new Date().toISOString()
      await db
        .from('prospecting_candidates')
        .update({ status: 'sent', sent_at: at, last_touch_at: at, error: null })
        .eq('id', cand.id)
    }
    await args.reschedule(nextSendAt(now, cfg.interval_minutes))
    return isFollowup ? 'followup' : 'sent'
  } catch (err) {
    const code =
      err instanceof SendMessageError || err instanceof AiError
        ? String((err as { code?: string }).code ?? 'unknown')
        : 'unknown'
    console.error(`${tag} ${isFollowup ? 'follow-up' : 'send'} failed (${code}):`, err)
    // Never retried automatically: a duplicate cold message is worse than
    // a missing one. A failed follow-up keeps its count (no second try).
    if (!isFollowup) {
      // Code first (the UI translates it), then the provider's own words —
      // "meta_error" alone sent people to the server logs.
      const detail = err instanceof Error && err.message ? ` · ${err.message}` : ''
      await db
        .from('prospecting_candidates')
        .update({ status: 'failed', error: `${code}${detail}`.slice(0, 300) })
        .eq('id', cand.id)
    }
    if (failureScope(code) === 'campaign') return args.pause(code)
    await args.reschedule(nextSendAt(now, cfg.interval_minutes))
    return 'failed'
  }
}
