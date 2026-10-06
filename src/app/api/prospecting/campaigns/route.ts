// ============================================================
// /api/prospecting/campaigns  (admin+) — specs/prospecting-csv-import.md, part B
//
//   GET  — the account's campaigns with their funnel, counted from the
//          stamps (sent → replied → qualified), never from status.
//   POST — create a campaign from a list (a tag, e.g. "lista:…") and start
//          it: candidates, deals and pinned conversations are created now;
//          sending is done by the cron, one lead at a time.
//          `validate_only: true` runs every check and creates nothing — the
//          wizard calls it before importing a file for the campaign, so a
//          campaign that can't start doesn't leave a half-done import.
//
// Writes use the service role (the tables have no write policy); every
// query carries the caller's account id.
// ============================================================

import { NextResponse, after } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { audit } from '@/lib/audit'
import { parseCampaignConfig } from '@/lib/prospecting/logic'
import { activateCampaign, checkCampaignReady } from '@/lib/prospecting/activate'
import { runProspectingTick } from '@/lib/prospecting/tick'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function GET() {
  try {
    const { accountId } = await requireRole('admin')
    const db = supabaseAdmin()
    const { data: campaigns } = await db
      .from('prospecting_campaigns')
      .select('id, name, status, config, error, next_send_at, created_at')
      .eq('account_id', accountId)
      .order('created_at', { ascending: false })
      .limit(50)

    const ids = (campaigns ?? []).map((c) => c.id as string)
    const funnel = new Map<string, Record<string, number>>()
    if (ids.length > 0) {
      const { data: cands } = await db
        .from('prospecting_candidates')
        .select('campaign_id, status, sent_at, replied_at, qualified_at, opted_out_at, followups_sent')
        .eq('account_id', accountId)
        .in('campaign_id', ids)
        .limit(20000)
      for (const c of cands ?? []) {
        const f =
          funnel.get(c.campaign_id as string) ??
          { total: 0, queued: 0, sent: 0, replied: 0, qualified: 0, failed: 0, skipped: 0, opted_out: 0, followed_up: 0 }
        f.total++
        if (c.status === 'queued' || c.status === 'sending') f.queued++
        if (c.sent_at) f.sent++
        if (c.replied_at) f.replied++
        if (c.qualified_at) f.qualified++
        if (c.status === 'failed') f.failed++
        if (c.status === 'skipped') f.skipped++
        if (c.opted_out_at) f.opted_out++
        if ((c.followups_sent ?? 0) > 0) f.followed_up++
        funnel.set(c.campaign_id as string, f)
      }
    }

    return NextResponse.json({
      campaigns: (campaigns ?? []).map((c) => ({
        ...c,
        funnel: funnel.get(c.id as string) ?? null,
      })),
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(request: Request) {
  try {
    const { accountId, userId } = await requireRole('admin')
    const limit = checkRateLimit(`prospecting:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'invalid_body' }, { status: 400 })
    }
    const name = typeof body.name === 'string' ? body.name.trim().slice(0, 120) : ''
    if (!name) return NextResponse.json({ error: 'name_required' }, { status: 400 })
    const validateOnly = body.validate_only === true
    const sourceTagId = typeof body.source_tag_id === 'string' ? body.source_tag_id : ''
    if (!validateOnly && !UUID.test(sourceTagId)) {
      return NextResponse.json({ error: 'list_required' }, { status: 400 })
    }
    const importId = typeof body.import_id === 'string' && UUID.test(body.import_id) ? body.import_id : null

    const parsed = parseCampaignConfig((body.config ?? {}) as Record<string, unknown>)
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })
    const config = parsed.config

    const db = supabaseAdmin()
    if (!validateOnly) {
      const { data: tag } = await db
        .from('tags')
        .select('id')
        .eq('id', sourceTagId)
        .eq('account_id', accountId)
        .maybeSingle()
      if (!tag) return NextResponse.json({ error: 'list_required' }, { status: 400 })
    }

    const notReady = await checkCampaignReady(db, accountId, config)
    if (notReady) return NextResponse.json({ error: notReady }, { status: 400 })

    const { data: running } = await db
      .from('prospecting_campaigns')
      .select('id')
      .eq('account_id', accountId)
      .eq('status', 'running')
      .limit(1)
    if (running && running.length > 0) {
      return NextResponse.json({ error: 'another_running' }, { status: 409 })
    }
    if (validateOnly) return NextResponse.json({ ok: true })

    let ownImport: string | null = null
    if (importId) {
      const { data: imp } = await db
        .from('contact_imports')
        .select('id')
        .eq('id', importId)
        .eq('account_id', accountId)
        .maybeSingle()
      ownImport = (imp?.id as string | undefined) ?? null
    }

    const { data: campaign, error } = await db
      .from('prospecting_campaigns')
      .insert({
        account_id: accountId,
        name,
        import_id: ownImport,
        status: 'draft',
        config: { ...config, source_tag_id: sourceTagId },
        created_by: userId,
      })
      .select('id')
      .single()
    if (error || !campaign) {
      console.error('[prospecting POST] insert failed:', error)
      return NextResponse.json({ error: 'failed' }, { status: 500 })
    }

    const result = await activateCampaign(db, {
      accountId,
      campaignId: campaign.id as string,
      campaignName: name,
      sourceTagId,
      config,
    })
    if (result.queued === 0) {
      await db
        .from('prospecting_campaigns')
        .update({ status: 'completed', error: 'list_empty' })
        .eq('id', campaign.id)
      return NextResponse.json({ id: campaign.id, ...result, status: 'completed' })
    }

    const { error: runErr } = await db
      .from('prospecting_campaigns')
      .update({ status: 'running', next_send_at: new Date().toISOString() })
      .eq('id', campaign.id)
    if (runErr) {
      // The one-running-per-account index lost a race.
      await db.from('prospecting_campaigns').update({ status: 'paused', error: 'another_running' }).eq('id', campaign.id)
      return NextResponse.json({ error: 'another_running' }, { status: 409 })
    }

    // First pass right away instead of waiting for the next cron hit.
    // Same window/cap/claim rules as any tick; runs after the response.
    after(() =>
      runProspectingTick(new Date(), { campaignId: campaign.id as string }).catch((err) =>
        console.error('[prospecting] first pass failed:', err),
      ),
    )
    void audit({
      accountId,
      actorUserId: userId,
      action: 'prospecting.started',
      resourceType: 'prospecting_campaign',
      resourceId: campaign.id as string,
      metadata: { name, channel: config.channel_kind, queued: result.queued, skipped: result.skipped },
    })
    return NextResponse.json({ id: campaign.id, ...result, status: 'running' })
  } catch (err) {
    return toErrorResponse(err)
  }
}
