// ============================================================
// Activate a prospecting campaign: every contact of the source list
// becomes a candidate with a deal in the entry stage and a conversation
// pinned to the campaign's number and agent — or is skipped with a
// nominal reason. Service role; every query is scoped to the account.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveAuditUserId } from '@/lib/api/v1/contacts'
import { normalizeImportPhone } from '@/lib/contacts/br-phone'
import type { CampaignConfig } from './logic'

/** Leads per campaign (enqueueing is bulk; the per-lead work happens at send time). */
export const MAX_CANDIDATES = 5000

export type ActivationError =
  | 'agent_missing'
  | 'channel_missing'
  | 'channel_disconnected'
  | 'whatsapp_not_configured'
  | 'template_not_approved'
  | 'stage_missing'
  | 'list_empty'

/** Everything the campaign depends on must exist before anything is written. */
export async function checkCampaignReady(
  db: SupabaseClient,
  accountId: string,
  config: CampaignConfig,
): Promise<ActivationError | null> {
  const { data: agent } = await db
    .from('ai_configs')
    .select('id')
    .eq('id', config.agent_id)
    .eq('account_id', accountId)
    .maybeSingle()
  if (!agent) return 'agent_missing'

  const { data: stages } = await db
    .from('pipeline_stages')
    .select('id')
    .eq('pipeline_id', config.pipeline_id)
    .in('id', [config.entry_stage_id, config.qualified_stage_id])
  const { data: pipeline } = await db
    .from('pipelines')
    .select('id')
    .eq('id', config.pipeline_id)
    .eq('account_id', accountId)
    .maybeSingle()
  if (!pipeline || (stages ?? []).length !== 2) return 'stage_missing'

  if (config.channel_kind === 'waha') {
    const { data: ch } = await db
      .from('whatsapp_waha_channels')
      .select('id, status')
      .eq('id', config.channel_id!)
      .eq('account_id', accountId)
      .maybeSingle()
    if (!ch) return 'channel_missing'
    if (ch.status !== 'connected') return 'channel_disconnected'
  } else {
    const { data: wa } = await db
      .from('whatsapp_config')
      .select('id')
      .eq('account_id', accountId)
      .eq('is_primary', true)
      .maybeSingle()
    if (!wa) return 'whatsapp_not_configured'
    let q = db
      .from('message_templates')
      .select('id')
      .eq('account_id', accountId)
      .eq('name', config.template_name!)
      .in('status', ['APPROVED', 'Approved'])
    if (config.template_language) q = q.eq('language', config.template_language)
    const { data: tpl } = await q.limit(1)
    if (!tpl || tpl.length === 0) return 'template_not_approved'
  }
  return null
}

interface ListContact {
  id: string
  name: string | null
  company: string | null
  phone: string
  opted_out_at: string | null
  consent_basis: string | null
}

export interface ActivationResult {
  queued: number
  skipped: number
  capped: boolean
}

/**
 * Enqueue every contact of the list. Cheap and bulk: no deal or
 * conversation is created here — that happens when each lead's turn comes
 * (`prepareCandidate`), so a 5,000-lead list neither times out the request
 * nor floods the pipeline with cards nobody has contacted yet.
 */
export async function activateCampaign(
  db: SupabaseClient,
  args: { accountId: string; campaignId: string; campaignName: string; sourceTagId: string; config: CampaignConfig },
): Promise<ActivationResult> {
  const { accountId, campaignId } = args

  const ids: string[] = []
  for (let from = 0; from <= MAX_CANDIDATES; from += 1000) {
    const { data } = await db
      .from('contact_tags')
      .select('contact_id')
      .eq('tag_id', args.sourceTagId)
      .order('contact_id')
      .range(from, from + 999)
    const page = (data ?? []).map((l) => l.contact_id as string)
    ids.push(...page)
    if (page.length < 1000) break
  }
  const capped = ids.length > MAX_CANDIDATES
  const contactIds = ids.slice(0, MAX_CANDIDATES)

  let queued = 0
  let skipped = 0
  for (let i = 0; i < contactIds.length; i += 500) {
    const { data } = await db
      .from('contacts')
      .select('id, name, company, phone, opted_out_at, consent_basis')
      .eq('account_id', accountId)
      .in('id', contactIds.slice(i, i + 500))
    const rows = ((data ?? []) as ListContact[]).map((c) => {
      const reason = c.opted_out_at
        ? 'opted_out'
        : c.consent_basis === 'third_party_list'
          ? 'third_party_list'
          : !normalizeImportPhone(c.phone).ok
            ? 'invalid_phone'
            : null
      if (reason) skipped++
      else queued++
      return {
        campaign_id: campaignId,
        account_id: accountId,
        contact_id: c.id,
        status: reason ? 'skipped' : 'queued',
        error: reason,
      }
    })
    if (rows.length > 0) {
      await db
        .from('prospecting_candidates')
        .upsert(rows, { onConflict: 'campaign_id,contact_id', ignoreDuplicates: true })
    }
  }
  return { queued, skipped, capped }
}

export type PrepareResult =
  | { ok: true; conversationId: string; dealId: string }
  | { ok: false; reason: 'in_service' | 'failed' | 'opted_out' }

/**
 * Right before a lead's first message: its conversation (pinned to the
 * campaign's number and agent) and its deal in the entry stage. A
 * conversation that already has history is a customer in service — cold
 * outreach never hijacks it.
 */
export async function prepareCandidate(
  db: SupabaseClient,
  args: {
    accountId: string
    campaignName: string
    candidateId: string
    contactId: string
    config: CampaignConfig
  },
): Promise<PrepareResult> {
  const { accountId, config } = args
  const { data: c } = await db
    .from('contacts')
    .select('id, name, company, phone, opted_out_at')
    .eq('id', args.contactId)
    .eq('account_id', accountId)
    .maybeSingle()
  if (!c || c.opted_out_at) return { ok: false, reason: 'opted_out' }
  const ownerUserId = await resolveAuditUserId(db, accountId)

  const { data: conv } = await db
    .from('conversations')
    .select('id')
    .eq('account_id', accountId)
    .eq('contact_id', c.id)
    .maybeSingle()
  let conversationId = conv?.id as string | undefined
  if (conversationId) {
    const { count } = await db
      .from('messages')
      .select('id', { count: 'exact', head: true })
      .eq('conversation_id', conversationId)
    if ((count ?? 0) > 0) return { ok: false, reason: 'in_service' }
    await db
      .from('conversations')
      .update({ whatsapp_channel_id: config.channel_id, pinned_ai_agent_id: config.agent_id })
      .eq('id', conversationId)
  } else {
    const { data: created, error } = await db
      .from('conversations')
      .insert({
        account_id: accountId,
        user_id: ownerUserId,
        contact_id: c.id,
        whatsapp_channel_id: config.channel_id,
        pinned_ai_agent_id: config.agent_id,
      })
      .select('id')
      .single()
    if (error || !created) return { ok: false, reason: 'failed' }
    conversationId = created.id as string
  }

  const { data: deal, error: dealErr } = await db
    .from('deals')
    .insert({
      account_id: accountId,
      user_id: ownerUserId,
      pipeline_id: config.pipeline_id,
      stage_id: config.entry_stage_id,
      contact_id: c.id,
      conversation_id: conversationId,
      title: (c.company || c.name || c.phone).slice(0, 200),
      notes: `${args.campaignName}\n\n${config.criteria}`.slice(0, 4000),
    })
    .select('id')
    .single()
  if (dealErr || !deal) return { ok: false, reason: 'failed' }

  await db
    .from('prospecting_candidates')
    .update({ conversation_id: conversationId, deal_id: deal.id })
    .eq('id', args.candidateId)
  return { ok: true, conversationId, dealId: deal.id as string }
}
