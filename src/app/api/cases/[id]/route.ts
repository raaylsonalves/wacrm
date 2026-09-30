// /api/cases/[id] — one case (specs/human-cases.md §4).
//   GET  (viewer+) — the case, its conversation excerpt and event timeline.
//   POST (agent+)  — { action: claim | done | need_info | escalate | cancel, note? }
//        done / need_info queue a note for the AI to relay to the customer
//        (run after the response; the cron retries a frozen run);
//        escalate hands the conversation to the person who clicked.

import { NextResponse, after } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { audit } from '@/lib/audit'
import { loadCase, logEvent, transitionCase } from '@/lib/cases/store'
import { relayCase } from '@/lib/cases/relay'
import { handOffToHuman } from '@/lib/ai/auto-reply'
import { buildHandoffMeta } from '@/lib/ai/handoff'
import { resolveAuditUserId } from '@/lib/api/v1/contacts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { accountId } = await requireRole('viewer')
    const { id } = await params
    if (!UUID.test(id)) return NextResponse.json({ error: 'not_found' }, { status: 404 })
    const db = supabaseAdmin()
    const { data: c } = await db
      .from('human_cases')
      .select('*, contact:contacts(name, phone)')
      .eq('id', id)
      .eq('account_id', accountId)
      .maybeSingle()
    if (!c) return NextResponse.json({ error: 'not_found' }, { status: 404 })
    const { data: events } = await db
      .from('human_case_events')
      .select('id, kind, actor_kind, actor_user_id, body, created_at')
      .eq('case_id', id)
      .eq('account_id', accountId)
      .order('created_at', { ascending: true })
    return NextResponse.json({ case: c, events: events ?? [] })
  } catch (err) {
    return toErrorResponse(err)
  }
}

type HumanAction = 'done' | 'need_info' | 'escalate' | 'cancel'

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { accountId, userId } = await requireRole('agent')
    const limit = checkRateLimit(`cases:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)
    const { id } = await params
    if (!UUID.test(id)) return NextResponse.json({ error: 'not_found' }, { status: 404 })
    const body = await request.json().catch(() => null)
    const action = String(body?.action ?? '')
    const note = typeof body?.note === 'string' ? body.note.trim().slice(0, 1000) : ''
    const db = supabaseAdmin()

    if (action === 'claim') {
      const row = await loadCase(db, accountId, id)
      if (!row) return NextResponse.json({ error: 'not_found' }, { status: 404 })
      await db
        .from('human_cases')
        .update({ claimed_by: userId, updated_at: new Date().toISOString() })
        .eq('id', id)
        .eq('account_id', accountId)
      await logEvent(db, { caseId: id, accountId, kind: 'claimed', actorKind: 'human', actorUserId: userId })
      return NextResponse.json({ success: true })
    }
    if (!['done', 'need_info', 'escalate', 'cancel'].includes(action)) {
      return NextResponse.json({ error: 'invalid_action' }, { status: 400 })
    }
    if ((action === 'done' || action === 'need_info') && note.length < 2) {
      return NextResponse.json({ error: 'note_required' }, { status: 400 })
    }

    const t = await transitionCase(db, {
      accountId,
      caseId: id,
      action: action as HumanAction,
      actorKind: 'human',
      actorUserId: userId,
      note: note || null,
    })
    if (!t.ok) {
      return NextResponse.json({ error: t.error }, { status: t.error === 'not_found' ? 404 : 409 })
    }

    if (!t.noop && (action === 'done' || action === 'need_info')) {
      // The customer hears it from the AI, after this response returns.
      after(async () => {
        await relayCase(supabaseAdmin(), accountId, id)
      })
    }
    if (!t.noop && action === 'escalate') {
      // The person who clicked takes the conversation; the customer is told.
      const owner = await resolveAuditUserId(db, accountId)
      await handOffToHuman(
        db,
        t.row.conversation_id,
        { handoffAgentId: userId },
        null,
        'case_escalated',
        buildHandoffMeta({}),
        { accountId, contactId: t.row.contact_id, userId: owner },
      )
    }

    void audit({
      accountId,
      actorUserId: userId,
      action: `case.${action}`,
      resourceType: 'human_case',
      resourceId: id,
    })
    return NextResponse.json({ success: true, noop: t.noop })
  } catch (err) {
    return toErrorResponse(err)
  }
}
