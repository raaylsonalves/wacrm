// PATCH /api/prospecting/campaigns/[id]  (admin+) — { action: pause | resume | cancel }
// A running campaign's config is never edited in place: pause, and start
// a new one. Resume re-checks everything the campaign depends on.

import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { audit } from '@/lib/audit'
import { checkCampaignReady } from '@/lib/prospecting/activate'
import type { CampaignConfig } from '@/lib/prospecting/logic'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** GET — the campaign's leads, one row each, with what happened to them. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { accountId } = await requireRole('admin')
    const { id } = await params
    if (!UUID.test(id)) return NextResponse.json({ error: 'not_found' }, { status: 404 })
    const db = supabaseAdmin()
    const { data, error } = await db
      .from('prospecting_candidates')
      .select(
        'id, status, error, conversation_id, sent_at, replied_at, qualified_at, opted_out_at, followups_sent, contact:contacts(name, phone, company)',
      )
      .eq('campaign_id', id)
      .eq('account_id', accountId)
      .order('created_at', { ascending: true })
      .limit(1000)
    if (error) return NextResponse.json({ error: 'failed' }, { status: 500 })
    return NextResponse.json({ leads: data ?? [] })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { accountId, userId } = await requireRole('admin')
    const limit = checkRateLimit(`prospecting:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)
    const { id } = await params
    if (!UUID.test(id)) return NextResponse.json({ error: 'not_found' }, { status: 404 })

    const body = await request.json().catch(() => null)
    const action = body?.action
    const db = supabaseAdmin()
    const { data: c } = await db
      .from('prospecting_campaigns')
      .select('id, status, config')
      .eq('id', id)
      .eq('account_id', accountId)
      .maybeSingle()
    if (!c) return NextResponse.json({ error: 'not_found' }, { status: 404 })

    const set = async (patch: Record<string, unknown>) =>
      db
        .from('prospecting_campaigns')
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq('id', id)
        .eq('account_id', accountId)

    if (action === 'pause') {
      if (c.status !== 'running') return NextResponse.json({ error: 'not_running' }, { status: 409 })
      await set({ status: 'paused', error: null })
    } else if (action === 'resume') {
      if (c.status !== 'paused') return NextResponse.json({ error: 'not_paused' }, { status: 409 })
      const notReady = await checkCampaignReady(db, accountId, c.config as CampaignConfig)
      if (notReady) return NextResponse.json({ error: notReady }, { status: 400 })
      const { error } = await set({ status: 'running', error: null, next_send_at: new Date().toISOString() })
      if (error) return NextResponse.json({ error: 'another_running' }, { status: 409 })
    } else if (action === 'cancel') {
      if (c.status === 'completed' || c.status === 'cancelled') {
        return NextResponse.json({ error: 'already_finished' }, { status: 409 })
      }
      await set({ status: 'cancelled' })
      // Leads not yet contacted are released; sent ones keep their history.
      await db
        .from('prospecting_candidates')
        .update({ status: 'skipped', error: 'cancelled' })
        .eq('campaign_id', id)
        .eq('status', 'queued')
    } else {
      return NextResponse.json({ error: 'invalid_action' }, { status: 400 })
    }

    void audit({
      accountId,
      actorUserId: userId,
      action: `prospecting.${action}`,
      resourceType: 'prospecting_campaign',
      resourceId: id,
    })
    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
