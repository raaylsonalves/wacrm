import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { daysAgoStart, lastNDayKeys, localDayKey } from '@/lib/dashboard/date-utils'

// Rows are aggregated in-process over a bounded window. An active
// account writes a handful of rows per conversation, so 30 days sits
// comfortably under this cap; we surface `truncated` when it doesn't so
// the UI can say "showing a partial window" rather than under-reporting
// silently.
const MAX_ROWS = 10_000
const DEFAULT_WINDOW_DAYS = 30

interface UsageRow {
  created_at: string
  agent_id: string | null
  mode: 'auto_reply' | 'draft'
  provider: string
  model: string
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  /** NULL = the provider did not report it. */
  cached_tokens?: number | null
}

/**
 * GET /api/ai/usage?days=30  (admin+)
 *
 * Token-spend summary for the account's BYO key over the last `days`
 * (1–90, default 30): totals, per-mode + per-model breakdowns, and a
 * zero-filled daily series for charting. Admin-only, mirroring the
 * `ai_usage_log` SELECT policy — spend is billing-class.
 */
export async function GET(request: Request) {
  try {
    const { supabase, accountId } = await requireRole('admin')

    const url = new URL(request.url)
    const rawDays = Number(url.searchParams.get('days'))
    // Guard `>= 1`, not just `isFinite`: a missing/blank param is
    // Number(null)/Number('') === 0, which is finite — without the lower
    // bound the default would never apply and the window would collapse
    // to a single day.
    const days =
      Number.isFinite(rawDays) && rawDays >= 1
        ? Math.min(90, Math.floor(rawDays))
        : DEFAULT_WINDOW_DAYS

    // Align the query cutoff to the START of the oldest local day we'll
    // chart (not a rolling `now - N*24h` instant). Otherwise rows in the
    // oldest partial day would be counted in the totals but fall outside
    // every daily bucket, so the chart's bars wouldn't sum to the
    // headline total. Local-day boundaries match every other dashboard
    // chart (see lib/dashboard/date-utils).
    const since = daysAgoStart(days - 1)

    // Optional single-agent view (`?agent_id=<uuid>`). The account filter
    // stays explicit alongside RLS, so an id from another account can
    // only ever return nothing.
    const rawAgent = url.searchParams.get('agent_id')
    const agentFilter =
      rawAgent && /^[0-9a-f-]{36}$/i.test(rawAgent) ? rawAgent : null

    const readRows = (cols: string) => {
      const q = supabase
        .from('ai_usage_log')
        .select(cols)
        .eq('account_id', accountId)
        .gte('created_at', since.toISOString())
        .order('created_at', { ascending: false })
        .limit(MAX_ROWS + 1)
      return agentFilter ? q.eq('agent_id', agentFilter) : q
    }
    const cols =
      'created_at, agent_id, mode, provider, model, prompt_tokens, completion_tokens, total_tokens'
    let { data, error } = await readRows(`${cols}, cached_tokens`)
    // Migration 078 (cached_tokens) may not be applied yet.
    if (error && (error as { code?: string }).code === '42703') {
      ;({ data, error } = await readRows(cols))
    }

    if (error) {
      console.error('[ai/usage GET] fetch error:', error)
      return NextResponse.json(
        { error: 'Failed to load usage' },
        { status: 500 },
      )
    }

    const all = (data ?? []) as unknown as UsageRow[]
    const truncated = all.length > MAX_ROWS
    const rows = truncated ? all.slice(0, MAX_ROWS) : all

    // Totals.
    let promptTokens = 0
    let completionTokens = 0
    let totalTokens = 0
    // Cache share is computed ONLY over rows whose provider reported it —
    // an unreported row is unknown, not a miss.
    let cachedTokens = 0
    let cachedReportedPrompt = 0
    let cachedReportedCalls = 0

    // Per-mode + per-model tallies.
    const byMode = {
      auto_reply: { calls: 0, tokens: 0 },
      draft: { calls: 0, tokens: 0 },
    }
    const modelMap = new Map<
      string,
      { model: string; provider: string; calls: number; tokens: number }
    >()

    // Per-agent tally. Rows written before migration 074 (or whose agent
    // was later deleted) have a NULL agent — surfaced as its own bucket
    // ("agente anterior" in the UI) so the totals still add up.
    const agentMap = new Map<
      string | null,
      { agent_id: string | null; calls: number; tokens: number; last_at: string }
    >()

    // Zero-filled daily buckets so the chart shows quiet days as gaps,
    // not missing points. Local-day keys, oldest → newest — the same
    // helper every other dashboard chart uses, so day boundaries agree.
    const daily = new Map<string, { date: string; tokens: number; calls: number }>()
    for (const key of lastNDayKeys(days)) {
      daily.set(key, { date: key, tokens: 0, calls: 0 })
    }

    for (const r of rows) {
      promptTokens += r.prompt_tokens
      completionTokens += r.completion_tokens
      totalTokens += r.total_tokens
      if (typeof r.cached_tokens === 'number') {
        cachedTokens += r.cached_tokens
        cachedReportedPrompt += r.prompt_tokens
        cachedReportedCalls += 1
      }

      // `mode` is DB-CHECK-constrained to these two values.
      byMode[r.mode].calls += 1
      byMode[r.mode].tokens += r.total_tokens

      const mk = `${r.provider}:${r.model}`
      const m =
        modelMap.get(mk) ??
        { model: r.model, provider: r.provider, calls: 0, tokens: 0 }
      m.calls += 1
      m.tokens += r.total_tokens
      modelMap.set(mk, m)

      const ak = r.agent_id ?? null
      const a =
        agentMap.get(ak) ?? { agent_id: ak, calls: 0, tokens: 0, last_at: r.created_at }
      a.calls += 1
      a.tokens += r.total_tokens
      // Rows are newest-first, so the first one seen is the latest.
      agentMap.set(ak, a)

      const bucket = daily.get(localDayKey(r.created_at))
      if (bucket) {
        bucket.tokens += r.total_tokens
        bucket.calls += 1
      }
    }

    const byModel = [...modelMap.values()].sort((a, b) => b.tokens - a.tokens)

    return NextResponse.json({
      window_days: days,
      truncated,
      totals: {
        calls: rows.length,
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: totalTokens,
        cached_tokens: cachedTokens,
        // Prompt tokens of the calls that reported cache — the denominator
        // for the cache rate; 0 = no provider reported it.
        cache_reported_prompt_tokens: cachedReportedPrompt,
        cache_reported_calls: cachedReportedCalls,
      },
      by_mode: byMode,
      by_model: byModel,
      by_agent: [...agentMap.values()].sort((a, b) => b.tokens - a.tokens),
      daily: [...daily.values()],
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
