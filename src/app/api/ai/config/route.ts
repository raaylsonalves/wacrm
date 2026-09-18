import { NextResponse } from 'next/server'
import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { encrypt, decrypt } from '@/lib/whatsapp/encryption'
import { validateAiCredentials } from '@/lib/ai/validate'
import { embedTexts } from '@/lib/ai/embeddings'
import { AiError, type AiProvider, type AiProviderCredentials } from '@/lib/ai/types'
import { isUndefinedColumnError } from '@/lib/ai/config'

/** Cap on configured fallback tiers — a couple covers the real failure
 *  modes (provider outage, provider quota) without turning AI config
 *  into an open-ended rules engine. See specs/ai-provider-fallback-chain.md. */
const MAX_FALLBACK_TIERS = 2

function bad(message: string) {
  return NextResponse.json({ error: message }, { status: 400 })
}

const VALID_PROVIDERS: AiProvider[] = ['openai', 'anthropic', 'gemini']

interface RawFallbackInput {
  provider?: unknown
  model?: unknown
  api_key?: unknown
}

/**
 * Parse + validate the `fallbacks` array from the request body against
 * whatever fallback tiers are already stored (so a save that doesn't
 * touch a tier's key doesn't require re-entering it). Returns `null` on
 * a validation failure, with the reason in `error`.
 */
async function resolveFallbacks(
  raw: unknown,
  existing: { provider: string; model: string; api_key: string }[],
): Promise<{ tiers: AiProviderCredentials[] } | { error: string }> {
  if (raw === undefined) {
    // Field omitted entirely → leave the stored fallbacks unchanged.
    const tiers: AiProviderCredentials[] = []
    for (const tier of existing) {
      try {
        tiers.push({
          provider: tier.provider as AiProvider,
          model: tier.model,
          apiKey: decrypt(tier.api_key),
        })
      } catch {
        return { error: 'A stored fallback key could not be decrypted — re-enter it.' }
      }
    }
    return { tiers }
  }

  if (!Array.isArray(raw)) return { error: 'fallbacks must be an array' }
  if (raw.length > MAX_FALLBACK_TIERS) {
    return { error: `fallbacks supports at most ${MAX_FALLBACK_TIERS} tiers` }
  }

  const tiers: AiProviderCredentials[] = []
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i] as RawFallbackInput
    const provider = item?.provider as AiProvider
    if (!VALID_PROVIDERS.includes(provider)) {
      return { error: `fallbacks[${i}].provider must be "openai", "anthropic", or "gemini"` }
    }
    const model = typeof item?.model === 'string' ? item.model.trim() : ''
    if (!model) return { error: `fallbacks[${i}].model is required` }

    const rawKey = typeof item?.api_key === 'string' ? item.api_key.trim() : ''
    if (rawKey) {
      tiers.push({ provider, model, apiKey: rawKey })
      continue
    }
    // No key sent for this tier — reuse the stored one at the same
    // position if the provider/model still match; otherwise a key is
    // required (can't validate/save a tier with no key at all).
    const prior = existing[i]
    if (prior && prior.provider === provider && prior.model === model) {
      try {
        tiers.push({ provider, model, apiKey: decrypt(prior.api_key) })
        continue
      } catch {
        return { error: `fallbacks[${i}]: stored key could not be decrypted — re-enter it.` }
      }
    }
    return { error: `fallbacks[${i}].api_key is required` }
  }
  return { tiers }
}

/**
 * GET /api/ai/config
 *
 * Any member may read the config so the inbox/settings can reflect
 * whether AI is set up. The encrypted key is NEVER returned — only a
 * `has_key` flag; the settings form shows a masked placeholder.
 */
export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount()

    const BASE_COLUMNS =
      'provider, model, system_prompt, is_active, auto_reply_enabled, auto_reply_max_per_conversation, handoff_agent_id, api_key, embeddings_api_key'

    // `api_key` is selected only to derive `has_key` — it is stripped
    // out below and never returned to the client.
    let { data, error } = await supabase
      .from('ai_configs')
      .select(`${BASE_COLUMNS}, fallbacks`)
      .eq('account_id', accountId)
      .maybeSingle()

    // Migration 052 (`ai_configs.fallbacks`) may not be applied yet —
    // degrade to "no fallback configured" rather than a hard 500.
    if (error && isUndefinedColumnError(error)) {
      ;({ data, error } = await supabase
        .from('ai_configs')
        .select(BASE_COLUMNS)
        .eq('account_id', accountId)
        .maybeSingle())
    }

    if (error) {
      console.error('[ai/config GET] fetch error:', error)
      return NextResponse.json(
        { error: 'Failed to load AI configuration' },
        { status: 500 },
      )
    }

    if (!data) return NextResponse.json({ configured: false })
    // The keys are selected only to derive the has_* flags; neither is
    // returned to the client. Each fallback tier is reduced to
    // {provider, model, has_key} for the same reason.
    const { api_key, embeddings_api_key, fallbacks, ...safe } = data as typeof data & {
      fallbacks?: { provider: string; model: string; api_key: string }[]
    }
    const rawFallbacks = (fallbacks ?? []) as {
      provider: string
      model: string
      api_key: string
    }[]
    return NextResponse.json({
      configured: true,
      has_key: !!api_key,
      has_embeddings_key: !!embeddings_api_key,
      fallbacks: rawFallbacks.map((f) => ({
        provider: f.provider,
        model: f.model,
        has_key: !!f.api_key,
      })),
      ...safe,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * POST /api/ai/config  (admin+)
 *
 * Upsert the account's AI config. Validates the key with the provider
 * before persisting (mirrors the WhatsApp config verifying with Meta
 * first), then stores the key AES-256-GCM-encrypted. When `api_key` is
 * omitted the existing stored key is reused (the form sends it only
 * when the user re-enters it).
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')

    const limit = checkRateLimit(`ai-config:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') return bad('Invalid request body')

    const provider = body.provider as AiProvider
    if (provider !== 'openai' && provider !== 'anthropic' && provider !== 'gemini') {
      return bad('provider must be "openai", "anthropic", or "gemini"')
    }
    const model = typeof body.model === 'string' ? body.model.trim() : ''
    if (!model) return bad('model is required')

    const systemPrompt =
      typeof body.system_prompt === 'string' && body.system_prompt.trim()
        ? body.system_prompt.trim()
        : null
    const isActive = body.is_active === true
    const autoReplyEnabled = body.auto_reply_enabled === true

    let maxPer = Number(body.auto_reply_max_per_conversation)
    if (!Number.isFinite(maxPer)) maxPer = 3
    maxPer = Math.min(20, Math.max(1, Math.floor(maxPer)))

    // Handoff routing target for auto-reply. A non-empty string must be a
    // member of this account (else the conversation would be assigned to a
    // stranger); an empty string / null means "leave unassigned" (the
    // shared queue). Absent → left unchanged on update below.
    const rawHandoff =
      typeof body.handoff_agent_id === 'string' ? body.handoff_agent_id.trim() : ''
    const handoffProvided = 'handoff_agent_id' in body
    let handoffAgentId: string | null = null
    if (rawHandoff) {
      const { data: member } = await supabase
        .from('profiles')
        .select('user_id')
        .eq('account_id', accountId)
        .eq('user_id', rawHandoff)
        .maybeSingle()
      if (!member) return bad('handoff_agent_id must be a member of this account')
      handoffAgentId = rawHandoff
    }

    const rawKey = typeof body.api_key === 'string' ? body.api_key.trim() : ''

    // Embeddings key (optional, for semantic KB search): a non-empty
    // string sets/replaces it; an explicit null clears it; absent leaves
    // it unchanged. The form only sends it when the admin edits it.
    const rawEmbeddingsKey =
      typeof body.embeddings_api_key === 'string'
        ? body.embeddings_api_key.trim()
        : ''
    const clearEmbeddingsKey = body.embeddings_api_key === null

    // Reuse the stored key when the form didn't send a fresh one.
    let { data: existing } = await supabase
      .from('ai_configs')
      .select('id, provider, model, api_key, fallbacks')
      .eq('account_id', accountId)
      .maybeSingle()

    if (!existing) {
      // Either genuinely no config yet, or (defensively) the select
      // above 42703'd on `fallbacks` — Postgrest surfaces that as an
      // error, not as `data`, so retry without the column to tell the
      // two cases apart before treating this as "no existing config".
      const retry = await supabase
        .from('ai_configs')
        .select('id, provider, model, api_key')
        .eq('account_id', accountId)
        .maybeSingle()
      if (retry.data) existing = { ...retry.data, fallbacks: null }
    }

    const fallbacksResult = await resolveFallbacks(
      body.fallbacks,
      (existing?.fallbacks ?? []) as { provider: string; model: string; api_key: string }[],
    )
    if ('error' in fallbacksResult) return bad(fallbacksResult.error)
    const fallbackTiers = fallbacksResult.tiers

    let apiKeyPlain: string
    if (rawKey) {
      apiKeyPlain = rawKey
    } else if (existing?.api_key) {
      try {
        apiKeyPlain = decrypt(existing.api_key)
      } catch {
        return bad('Stored API key could not be decrypted — re-enter your key.')
      }
    } else {
      return bad('api_key is required')
    }

    // Only spend a provider round-trip when the credentials that affect
    // reachability actually changed. A save that just flips a toggle or
    // edits the system prompt on an existing, already-validated config
    // skips the call — no wasted token/latency on the account's key.
    const credentialsChanged =
      !existing ||
      rawKey !== '' ||
      provider !== existing.provider ||
      model !== existing.model

    if (credentialsChanged) {
      try {
        await validateAiCredentials({
          provider,
          model,
          apiKey: apiKeyPlain,
          systemPrompt,
          isActive,
          autoReplyEnabled,
          autoReplyMaxPerConversation: maxPer,
          handoffAgentId: null,
          embeddingsApiKey: null,
          fallbacks: [],
        })
      } catch (err) {
        if (err instanceof AiError) {
          return NextResponse.json(
            { error: err.message, code: err.code },
            { status: 400 },
          )
        }
        console.error('[ai/config POST] validation error:', err)
        return bad('Could not validate the API key with the provider.')
      }
    }

    // Validate each fallback tier whose key is newly-entered — a reused
    // stored key was already validated when it was first saved, so
    // re-checking it on every unrelated save would waste a round-trip
    // per tier for nothing.
    const existingFallbacks = (existing?.fallbacks ?? []) as
      | { provider: string; model: string; api_key: string }[]
      | null
    for (let i = 0; i < fallbackTiers.length; i++) {
      const tier = fallbackTiers[i]
      const priorTier = existingFallbacks?.[i]
      const isNew =
        !priorTier ||
        priorTier.provider !== tier.provider ||
        priorTier.model !== tier.model ||
        (Array.isArray(body.fallbacks) &&
          typeof (body.fallbacks[i] as RawFallbackInput)?.api_key === 'string' &&
          ((body.fallbacks[i] as RawFallbackInput).api_key as string).trim() !== '')
      if (!isNew) continue
      try {
        await validateAiCredentials({
          provider: tier.provider,
          model: tier.model,
          apiKey: tier.apiKey,
          systemPrompt: null,
          isActive: true,
          autoReplyEnabled: false,
          autoReplyMaxPerConversation: 3,
          handoffAgentId: null,
          embeddingsApiKey: null,
          fallbacks: [],
        })
      } catch (err) {
        if (err instanceof AiError) {
          return NextResponse.json(
            { error: `fallbacks[${i}]: ${err.message}`, code: err.code },
            { status: 400 },
          )
        }
        console.error('[ai/config POST] fallback validation error:', err)
        return bad(`Could not validate fallbacks[${i}]'s API key with the provider.`)
      }
    }

    // Validate a new embeddings key before storing (a cheap 1-input
    // embed), same "verify before save" discipline as the chat key.
    if (rawEmbeddingsKey) {
      try {
        await embedTexts(rawEmbeddingsKey, ['ping'])
      } catch (err) {
        if (err instanceof AiError) {
          return NextResponse.json(
            { error: `Embeddings key: ${err.message}`, code: err.code },
            { status: 400 },
          )
        }
        console.error('[ai/config POST] embeddings validation error:', err)
        return bad('Could not validate the embeddings key.')
      }
    }

    const encryptedKey = rawKey ? encrypt(rawKey) : null
    const encryptedFallbacks = fallbackTiers.map((tier) => ({
      provider: tier.provider,
      model: tier.model,
      api_key: encrypt(tier.apiKey),
    }))
    const shared: Record<string, unknown> = {
      provider,
      model,
      system_prompt: systemPrompt,
      is_active: isActive,
      auto_reply_enabled: autoReplyEnabled,
      auto_reply_max_per_conversation: maxPer,
      fallbacks: encryptedFallbacks,
    }
    // Only touch the handoff target when the form actually sent the field,
    // so a partial save (e.g. flipping a toggle) doesn't wipe it.
    if (handoffProvided) shared.handoff_agent_id = handoffAgentId
    if (rawEmbeddingsKey) {
      shared.embeddings_api_key = encrypt(rawEmbeddingsKey)
    } else if (clearEmbeddingsKey) {
      shared.embeddings_api_key = null
    }

    if (existing) {
      const payload = encryptedKey ? { ...shared, api_key: encryptedKey } : shared
      let { error: upErr } = await supabase
        .from('ai_configs')
        .update(payload)
        .eq('account_id', accountId)
      if (upErr && isUndefinedColumnError(upErr)) {
        // Migration 052 (`ai_configs.fallbacks`) hasn't been applied
        // yet — save everything else, but reject if the admin actually
        // tried to configure a fallback tier, rather than silently
        // dropping it.
        if (encryptedFallbacks.length > 0) {
          return bad(
            'Fallback providers require a pending database migration (052) to be applied first. Ask your administrator to run it, or save without a fallback provider for now.',
          )
        }
        const { fallbacks: _omit, ...payloadWithoutFallbacks } = payload
        void _omit
        ;({ error: upErr } = await supabase
          .from('ai_configs')
          .update(payloadWithoutFallbacks)
          .eq('account_id', accountId))
      }
      if (upErr) {
        console.error('[ai/config POST] update error:', upErr)
        return NextResponse.json(
          { error: 'Failed to save AI configuration' },
          { status: 500 },
        )
      }
    } else {
      const insertPayload = {
        account_id: accountId,
        created_by: userId,
        api_key: encryptedKey, // guaranteed non-null: rawKey required when no existing row
        ...shared,
      }
      let { error: insErr } = await supabase.from('ai_configs').insert(insertPayload)
      if (insErr && isUndefinedColumnError(insErr)) {
        if (encryptedFallbacks.length > 0) {
          return bad(
            'Fallback providers require a pending database migration (052) to be applied first. Ask your administrator to run it, or save without a fallback provider for now.',
          )
        }
        const { fallbacks: _omit, ...insertWithoutFallbacks } =
          insertPayload as Record<string, unknown>
        void _omit
        ;({ error: insErr } = await supabase
          .from('ai_configs')
          .insert(insertWithoutFallbacks))
      }
      if (insErr) {
        console.error('[ai/config POST] insert error:', insErr)
        return NextResponse.json(
          { error: 'Failed to save AI configuration' },
          { status: 500 },
        )
      }
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * DELETE /api/ai/config  (admin+)
 *
 * Removes the account's AI config (turns everything off and forgets the
 * key). Also used to recover from a corrupted encrypted key.
 */
export async function DELETE() {
  try {
    const { supabase, accountId } = await requireRole('admin')
    const { error } = await supabase
      .from('ai_configs')
      .delete()
      .eq('account_id', accountId)
    if (error) {
      console.error('[ai/config DELETE] error:', error)
      return NextResponse.json(
        { error: 'Failed to delete AI configuration' },
        { status: 500 },
      )
    }
    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
