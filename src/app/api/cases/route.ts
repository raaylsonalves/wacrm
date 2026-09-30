// GET /api/cases?view=team|customer|closed  (viewer+) — the case queue
// (specs/human-cases.md §4). Read through the service role with an explicit
// account filter, joined to the contact for the row label.

import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/ai/admin-client'

const VIEWS: Record<string, string[]> = {
  team: ['awaiting_human'],
  customer: ['awaiting_lead'],
  closed: ['resolved', 'escalated', 'cancelled'],
}

export async function GET(request: Request) {
  try {
    const { accountId } = await requireRole('viewer')
    const view = new URL(request.url).searchParams.get('view') ?? 'team'
    const statuses = VIEWS[view] ?? VIEWS.team
    const db = supabaseAdmin()
    const { data, error } = await db
      .from('human_cases')
      .select(
        'id, title, blocker, status, opened_by, claimed_by, relay_status, opened_at, updated_at, conversation_id, contact:contacts(name, phone)',
      )
      .eq('account_id', accountId)
      .in('status', statuses)
      .order(view === 'closed' ? 'updated_at' : 'opened_at', { ascending: view !== 'closed' })
      .limit(200)
    if (error) return NextResponse.json({ error: 'failed' }, { status: 500 })

    const { data: open } = await db
      .from('human_cases')
      .select('status')
      .eq('account_id', accountId)
      .in('status', ['awaiting_human', 'awaiting_lead'])
    const team = (open ?? []).filter((c) => c.status === 'awaiting_human').length
    return NextResponse.json({
      cases: data ?? [],
      counts: { team, customer: (open ?? []).length - team },
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
