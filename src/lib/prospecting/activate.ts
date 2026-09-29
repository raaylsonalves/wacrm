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

/** v1 cap per activation: the pass runs inside one request. */
export const MAX_CANDIDATES = 500

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

export async function activateCampaign(
  db: SupabaseClient,
  args: { accountId: string; campaignId: string; campaignName: string; sourceTagId: string; config: CampaignConfig },
): Promise<ActivationResult> {
  const { accountId, campaignId, config } = args
  const ownerUserId = await resolveAuditUserId(db, accountId)

  const { data: links } = await db
    .from('contact_tags')
    .select('contact_id')
    .eq('tag_id', args.sourceTagId)
    .limit(MAX_CANDIDATES + 1)
  const ids = (links ?? []).map((l) => l.contact_id as string)
  const capped = ids.length > MAX_CANDIDATES
  const contactIds = ids.slice(0, MAX_CANDIDATES)

  const contacts: ListContact[] = []
  for (let i = 0; i < contactIds.length; i += 200) {
    const { data } = await db
      .from('contacts')
      .select('id, name, company, phone, opted_out_at, consent_basis')
      .eq('account_id', accountId)
      .in('id', contactIds.slice(i, i + 200))
    contacts.push(...((data ?? []) as ListContact[]))
  }

  let queued = 0
  let skipped = 0
  const skip = async (contactId: string, reason: string) => {
    skipped++
    await db.from('prospecting_candidates').upsert(
      {
        campaign_id: campaignId,
        account_id: accountId,
        contact_id: contactId,
        status: 'skipped',
        error: reason,
      },
      { onConflict: 'campaign_id,contact_id', ignoreDuplicates: true },
    )
  }

  for (const c of contacts) {
    if (c.opted_out_at) {
      await skip(c.id, 'opted_out')
      continue
    }
    if (c.consent_basis === 'third_party_list') {
      await skip(c.id, 'third_party_list')
      continue
    }
    if (!normalizeImportPhone(c.phone).ok) {
      await skip(c.id, 'invalid_phone')
      continue
    }

    // One conversation per contact. A conversation with history is a
    // customer in service: cold outreach never hijacks it.
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
      if ((count ?? 0) > 0) {
        await skip(c.id, 'in_service')
        continue
      }
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
      if (error || !created) {
        await skip(c.id, 'failed')
        continue
      }
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
    if (dealErr || !deal) {
      await skip(c.id, 'failed')
      continue
    }

    const { error: candErr } = await db.from('prospecting_candidates').upsert(
      {
        campaign_id: campaignId,
        account_id: accountId,
        contact_id: c.id,
        deal_id: deal.id,
        conversation_id: conversationId,
        status: 'queued',
      },
      { onConflict: 'campaign_id,contact_id', ignoreDuplicates: true },
    )
    if (candErr) {
      skipped++
      continue
    }
    queued++
  }

  return { queued, skipped, capped }
}
