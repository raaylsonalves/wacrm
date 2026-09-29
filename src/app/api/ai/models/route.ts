import { createHash } from 'node:crypto'
import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { decrypt } from '@/lib/whatsapp/encryption'
import type { AiProvider } from '@/lib/ai/types'
import {
  ModelListError,
  fetchModelList,
  type ModelOption,
} from '@/lib/ai/models'

/**
 * POST /api/ai/models  (admin+)
 *
 * The model picker's list: what the given provider key can actually use
 * (specs/ai-agents-management.md §1). POST, not GET, so a candidate key
 * never travels in a query string. A blank `api_key` falls back to the
 * key already stored for `agent_id` (or the default agent) — the same rule
 * as /api/ai/test — so editing an agent doesn't require re-pasting it.
 *
 * The response never contains the key; failures are a short code
 * (`invalid_key`, `rate_limited`, `unreachable`) the UI turns into
 * "type the model id instead" — a provider hiccup must never block a save.
 */

// A model catalogue barely changes minute to minute, and every open of the
// picker would otherwise cost a provider call. The cache key hashes the
// account, provider AND the key, so one account's list can never serve
// another's, and the key itself is never held.
const TTL_MS = 10 * 60 * 1000
const MAX_ENTRIES = 200
const cache = new Map<string, { at: number; models: ModelOption[] }>()

function cacheKey(accountId: string, provider: string, apiKey: string): string {
  return createHash('sha256').update(`${accountId}\0${provider}\0${apiKey}`).digest('hex')
}

export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')

    const limit = checkRateLimit(`ai-models:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
    }

    const provider = body.provider as AiProvider
    if (
      provider !== 'openai' &&
      provider !== 'anthropic' &&
      provider !== 'gemini' &&
      provider !== 'openrouter'
    ) {
      return NextResponse.json(
        { error: 'provider must be "openai", "anthropic", "gemini", or "openrouter"' },
        { status: 400 },
      )
    }

    let apiKey = typeof body.api_key === 'string' ? body.api_key.trim() : ''
    if (!apiKey) {
      const agentId = typeof body.agent_id === 'string' ? body.agent_id.trim() : ''
      let query = supabase.from('ai_configs').select('api_key').eq('account_id', accountId)
      query = agentId ? query.eq('id', agentId) : query.eq('is_default', true)
      const { data: stored } = await query.maybeSingle()
      if (stored?.api_key) {
        try {
          apiKey = decrypt(stored.api_key)
        } catch {
          // OpenRouter's catalogue needs no key, so an unreadable stored
          // key must not hide the list; every other provider does need it.
          if (provider !== 'openrouter') {
            return NextResponse.json({
              ok: false,
              code: 'invalid_key',
              error: 'The stored key could not be decrypted — re-enter it.',
            })
          }
          apiKey = ''
        }
      }
    }

    // OpenRouter's catalogue is public, so it lists without a key; the
    // others need one.
    if (!apiKey && provider !== 'openrouter') {
      return NextResponse.json({
        ok: false,
        code: 'invalid_key',
        error: 'Enter an API key to list its models.',
      })
    }

    const key = cacheKey(accountId, provider, apiKey)
    const hit = cache.get(key)
    if (hit && Date.now() - hit.at < TTL_MS) {
      return NextResponse.json({ ok: true, models: hit.models, cached: true })
    }

    try {
      const models = await fetchModelList({ provider, apiKey })
      if (cache.size >= MAX_ENTRIES) cache.clear()
      cache.set(key, { at: Date.now(), models })
      return NextResponse.json({ ok: true, models })
    } catch (err) {
      if (err instanceof ModelListError) {
        // 200 with `ok: false`: this is an expected, user-visible outcome
        // (bad key, provider down), not a server fault, and the picker
        // handles it by offering the free-text field.
        return NextResponse.json({ ok: false, code: err.code, error: err.message })
      }
      console.error('[ai/models] unexpected error:', err instanceof Error ? err.message : err)
      return NextResponse.json({
        ok: false,
        code: 'unreachable',
        error: 'Could not list models',
      })
    }
  } catch (err) {
    return toErrorResponse(err)
  }
}
