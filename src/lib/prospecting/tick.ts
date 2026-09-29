// ============================================================
// One prospecting tick (called by the automations cron). For each running
// campaign whose turn has come: at most ONE candidate is sent, and only
// inside the sending window, under the daily cap and the WAHA warm-up
// ceiling. Anything "not yet" just moves next_send_at.
// ============================================================

import { supabaseAdmin } from '@/lib/ai/admin-client'
import { loadAiConfig } from '@/lib/ai/config'
import { generateReplyWithFallback } from '@/lib/ai/generate-with-fallback'
import { logAiUsage } from '@/lib/ai/usage'
import { AiError } from '@/lib/ai/types'
import { sendMessageToConversation, SendMessageError } from '@/lib/whatsapp/send-message'
import {
  buildApproachPrompt,
  failureScope,
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

export interface TickSummary {
  campaigns: number
  sent: number
  failed: number
  paused: number
}

export async function runProspectingTick(now: Date = new Date()): Promise<TickSummary> {
  const db = supabaseAdmin()
  const summary: TickSummary = { campaigns: 0, sent: 0, failed: 0, paused: 0 }
  const { data } = await db
    .from('prospecting_campaigns')
    .select('id, account_id, name, config, next_send_at')
    .eq('status', 'running')
    .lte('next_send_at', now.toISOString())
    .limit(50)

  for (const c of (data ?? []) as CampaignRow[]) {
    summary.campaigns++
    try {
      const r = await tickCampaign(c, now)
      if (r === 'sent') summary.sent++
      if (r === 'failed') summary.failed++
      if (r === 'paused') summary.paused++
    } catch (err) {
      console.error(`[prospecting ${c.id}] tick failed:`, err)
    }
  }
  return summary
}

type TickResult = 'waiting' | 'sent' | 'failed' | 'paused' | 'completed'

async function tickCampaign(c: CampaignRow, now: Date): Promise<TickResult> {
  const db = supabaseAdmin()
  const cfg = c.config
  const tag = `[prospecting ${c.id}]`
  const reschedule = (at: Date) =>
    db.from('prospecting_campaigns').update({ next_send_at: at.toISOString(), updated_at: now.toISOString() }).eq('id', c.id)
  const pause = async (error: string) => {
    await db
      .from('prospecting_campaigns')
      .update({ status: 'paused', error, updated_at: now.toISOString() })
      .eq('id', c.id)
    console.warn(`${tag} paused: ${error}`)
    return 'paused' as const
  }

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

  // Daily cap across ALL of the account's cold sends, not per campaign.
  const dayAgo = new Date(now.getTime() - 86_400_000).toISOString()
  const { data: recent } = await db
    .from('prospecting_candidates')
    .select('attempted_at')
    .eq('account_id', c.account_id)
    .gte('attempted_at', dayAgo)
    .order('attempted_at', { ascending: true })
  const cap = Math.min(cfg.daily_limit, warmupCeiling(cfg.channel_kind, connectedAt, now))
  if ((recent ?? []).length >= cap) {
    const oldest = new Date(recent![0].attempted_at as string)
    await reschedule(new Date(oldest.getTime() + 86_400_000 + 60_000))
    return 'waiting'
  }

  const { data: claimed } = await db.rpc('claim_prospecting_candidate', { p_campaign_id: c.id })
  const cand = (claimed as { id: string; contact_id: string; conversation_id: string | null }[] | null)?.[0]
  if (!cand) {
    await db
      .from('prospecting_campaigns')
      .update({ status: 'completed', updated_at: now.toISOString() })
      .eq('id', c.id)
    return 'completed'
  }
  const failCandidate = (error: string) =>
    db.from('prospecting_candidates').update({ status: 'failed', error }).eq('id', cand.id)

  const { data: contact } = await db
    .from('contacts')
    .select('name, company, opted_out_at')
    .eq('id', cand.contact_id)
    .eq('account_id', c.account_id)
    .maybeSingle()
  if (!contact || contact.opted_out_at || !cand.conversation_id) {
    await db.from('prospecting_candidates').update({ status: 'skipped', error: 'opted_out' }).eq('id', cand.id)
    await reschedule(now)
    return 'waiting'
  }

  try {
    let result
    if (cfg.channel_kind === 'waha') {
      const agent = await loadAiConfig(db, c.account_id, { agentId: cfg.agent_id })
      if (!agent) {
        await failCandidate('agent_missing')
        return pause('agent_missing')
      }
      const generation = await generateReplyWithFallback({
        config: agent,
        systemPrompt: buildApproachPrompt({
          instruction: cfg.instruction,
          criteria: cfg.criteria,
          contact: { name: contact.name, company: contact.company },
          businessContext: agent.systemPrompt,
        }),
        messages: [{ role: 'user', content: 'Write the first message now.' }],
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
      if (!text || generation.handoff) throw new AiError('The model wrote no approach.', { code: 'empty_reply' })
      result = await sendMessageToConversation(db, c.account_id, {
        conversationId: cand.conversation_id,
        messageType: 'text',
        contentText: `${text}\n\n${optOutLine(process.env.NEXT_PUBLIC_APP_LOCALE)}`,
      })
    } else {
      result = await sendMessageToConversation(db, c.account_id, {
        conversationId: cand.conversation_id,
        messageType: 'template',
        templateName: cfg.template_name,
        templateLanguage: cfg.template_language,
        templateParams: renderTemplateParams(cfg.template_params, {
          name: contact.name,
          company: contact.company,
        }),
      })
    }

    // Sent by the system, not by a person.
    await db
      .from('messages')
      .update({ sender_type: 'bot', ai_generated: cfg.channel_kind === 'waha' })
      .eq('id', result.messageId)
    await db
      .from('prospecting_candidates')
      .update({ status: 'sent', sent_at: new Date().toISOString(), error: null })
      .eq('id', cand.id)
    await reschedule(nextSendAt(now, cfg.interval_minutes))
    return 'sent'
  } catch (err) {
    const code =
      err instanceof SendMessageError || err instanceof AiError
        ? String((err as { code?: string }).code ?? 'unknown')
        : 'unknown'
    console.error(`${tag} send failed (${code}):`, err)
    // Never retried automatically: a duplicate cold message is worse
    // than a missing one. The candidate stays failed for a person to check.
    await failCandidate(code)
    if (failureScope(code) === 'campaign') return pause(code)
    await reschedule(nextSendAt(now, cfg.interval_minutes))
    return 'failed'
  }
}
