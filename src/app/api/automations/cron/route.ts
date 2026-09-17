import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { resumePendingExecution } from '@/lib/automations/engine'
import type { AutomationContext } from '@/lib/automations/engine'

/**
 * Drain due `automation_pending_executions` rows. Meant to be hit
 * on a schedule (Vercel Cron / external pinger) — requires a shared
 * secret matching `AUTOMATION_CRON_SECRET`, supplied either as the
 * `x-cron-secret` header (external pingers) or as
 * `Authorization: Bearer <secret>` (Vercel Cron, which cannot send
 * custom headers and always sends this form instead).
 *
 * The claim step (status = 'running') serves as a simple lock so
 * overlapping invocations don't double-process rows. Best-effort
 * only; expensive SELECT ... FOR UPDATE is avoided in favor of a
 * two-step UPDATE-by-id.
 *
 * A row can get stuck at 'running' forever if the process dies between
 * the claim and resumePendingExecution's own status update (a
 * serverless timeout or pod recycle) — nothing else ever re-reads a
 * 'running' row. Rows still running past STALE_RUNNING_MS are reclaimed
 * the same way pending ones are claimed.
 */
const STALE_RUNNING_MS = 10 * 60 * 1000

export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  const bearer = request.headers.get('authorization')
  const supplied =
    request.headers.get('x-cron-secret') ??
    (bearer?.startsWith('Bearer ') ? bearer.slice(7) : '') ??
    ''
  const suppliedBuf = Buffer.from(supplied)
  const expectedBuf = Buffer.from(expected)
  if (
    suppliedBuf.length !== expectedBuf.length ||
    !timingSafeEqual(suppliedBuf, expectedBuf)
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const admin = supabaseAdmin()
  const nowIso = new Date().toISOString()
  const staleBeforeIso = new Date(Date.now() - STALE_RUNNING_MS).toISOString()

  const { data: due, error } = await admin
    .from('automation_pending_executions')
    .select('*')
    .eq('status', 'pending')
    .lte('run_at', nowIso)
    .order('run_at', { ascending: true })
    .limit(50)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Stale-'running' reclaim, separate from the due-'pending' query above
  // (different status filter, and this one is unbounded by run_at since
  // it's about staleness of the claim, not the original schedule).
  const { data: stale } = await admin
    .from('automation_pending_executions')
    .select('*')
    .eq('status', 'running')
    .lt('claimed_at', staleBeforeIso)
    .order('claimed_at', { ascending: true })
    .limit(50)

  const candidates = [...(due ?? []), ...(stale ?? [])]
  if (candidates.length === 0) return NextResponse.json({ processed: 0 })

  let processed = 0
  for (const row of candidates) {
    // Compare-and-swap on the exact state just read: a pending row must
    // still be pending, a stale-running row must still be running with
    // that same stale claimed_at — so two overlapping cron invocations
    // reclaiming the same stuck row can't both win.
    let claimQuery = admin
      .from('automation_pending_executions')
      .update({ status: 'running', claimed_at: nowIso })
      .eq('id', row.id)
    claimQuery =
      row.status === 'pending'
        ? claimQuery.eq('status', 'pending')
        : claimQuery.eq('status', 'running').lt('claimed_at', staleBeforeIso)
    const { data: claim } = await claimQuery.select('id').maybeSingle()
    if (!claim) continue

    await resumePendingExecution({
      id: row.id as string,
      automation_id: row.automation_id as string,
      // account_id is NOT NULL on automation_pending_executions
      // post-017; the engine uses it for tenant-scoped lookups.
      account_id: row.account_id as string,
      user_id: row.user_id as string,
      contact_id: (row.contact_id as string | null) ?? null,
      log_id: (row.log_id as string | null) ?? null,
      parent_step_id: (row.parent_step_id as string | null) ?? null,
      branch: (row.branch as 'yes' | 'no' | null) ?? null,
      next_step_position: row.next_step_position as number,
      context: (row.context as AutomationContext) ?? {},
    })
    processed++
  }

  return NextResponse.json({ processed })
}
