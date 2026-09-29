import type { SupabaseClient } from '@supabase/supabase-js'
import { decrypt } from '@/lib/whatsapp/encryption'
import type { AiConfig, AiProvider, AiProviderCredentials } from './types'
import { parseTranscriptionModel } from './transcribe'

interface RawFallbackRow {
  provider: AiProvider
  model: string
  api_key: string
}

interface AiConfigRow {
  id?: string
  provider: AiProvider
  model: string
  api_key: string
  system_prompt: string | null
  is_active: boolean
  auto_reply_enabled: boolean
  auto_reply_max_per_conversation: number
  handoff_agent_id: string | null
  embeddings_api_key: string | null
  fallbacks: RawFallbackRow[] | null
  agenda_enabled?: boolean
  handoff_keywords?: string[] | null
  transcription_model?: string | null
}

/** One row of `listAiAgents` — never the decrypted key, just enough
 *  for the agents list screen and the router builder's agent picker. */
export interface AiAgentSummary {
  id: string
  name: string
  provider: AiProvider
  model: string
  isDefault: boolean
  isActive: boolean
}

const CONFIG_COLUMNS_BASE =
  'id, provider, model, api_key, system_prompt, is_active, auto_reply_enabled, auto_reply_max_per_conversation, handoff_agent_id, embeddings_api_key'
const CONFIG_COLUMNS = `${CONFIG_COLUMNS_BASE}, fallbacks, agenda_enabled, handoff_keywords, transcription_model`

/** Postgres "undefined_column" — thrown by `fallbacks` not existing yet
 *  when migration 052 hasn't been applied. See the fallback query below. */
const UNDEFINED_COLUMN = '42703'

/** True when a Supabase/Postgres error is specifically "column does not
 *  exist" — used by callers (here and the `/api/ai/config` route) that
 *  select `ai_configs.fallbacks` directly, to degrade to "no fallback
 *  configured" instead of a hard failure when migration 052 hasn't run
 *  yet. Exported so route handlers can apply the same defensiveness. */
export function isUndefinedColumnError(error: unknown): boolean {
  return Boolean(error) && (error as { code?: string }).code === UNDEFINED_COLUMN
}

/**
 * Decrypt each configured fallback tier's key. A single corrupt tier
 * (rotated `ENCRYPTION_KEY`, manual DB edit) is dropped with a warning
 * rather than failing the whole config — the primary provider/model is
 * still usable, and `generateReplyWithFallback` just has one fewer tier
 * to fall back to.
 */
function decryptFallbacks(
  accountId: string,
  raw: RawFallbackRow[] | null,
): AiProviderCredentials[] {
  if (!raw || raw.length === 0) return []
  const out: AiProviderCredentials[] = []
  for (const tier of raw) {
    if (!tier?.api_key) continue
    try {
      out.push({
        provider: tier.provider,
        model: tier.model,
        apiKey: decrypt(tier.api_key),
      })
    } catch {
      console.error(
        `[ai config] fallback key for account ${accountId} (${tier.provider}) could not be decrypted — check ENCRYPTION_KEY; this fallback tier is skipped until re-entered.`,
      )
    }
  }
  return out
}

/**
 * Load and decrypt the account's AI config for *use* (draft or
 * auto-reply). Returns `null` when there's no row or the master switch
 * (`is_active`) is off — both mean "AI is not available", which callers
 * treat identically. Throws only if the stored key can't be decrypted
 * (mismatched `ENCRYPTION_KEY`), so that distinct failure surfaces
 * rather than looking like "not configured".
 *
 * Works with any client: pass the RLS-scoped SSR client from a
 * dashboard route, or the service-role admin client from the webhook.
 */
export async function loadAiConfig(
  db: SupabaseClient,
  accountId: string,
  opts: { requireActive?: boolean; agentId?: string } = {},
): Promise<AiConfig | null> {
  const { requireActive = true, agentId } = opts
  // No agentId → the account's default agent (migration 066). Every
  // caller from before multi-agent existed calls this with no
  // agentId, so an account with exactly one agent (today's only
  // shape, and still the common case) resolves the same row it
  // always did — is_default is backfilled true for it.
  let query = db.from('ai_configs').select(CONFIG_COLUMNS).eq('account_id', accountId)
  query = agentId ? query.eq('id', agentId) : query.eq('is_default', true)
  let { data, error } = await query.maybeSingle()

  // Defensive: if migration 052 (adds `ai_configs.fallbacks`) or 060
  // (adds `ai_configs.agenda_enabled`) hasn't been applied yet,
  // selecting either 42703s. Rather than taking down every draft/
  // auto-reply call on a deploy that outran its migration, retry
  // without the newer columns and treat them as "not configured" —
  // exactly how a freshly-migrated account with defaults behaves.
  if (error && isUndefinedColumnError(error)) {
    console.warn(
      '[ai config] ai_configs.fallbacks / agenda_enabled do not exist yet (migration 052/060 not applied) — provider fallback and agenda tools are disabled until they are.',
    )
    let retryQuery = db
      .from('ai_configs')
      .select(CONFIG_COLUMNS_BASE)
      .eq('account_id', accountId)
    retryQuery = agentId
      ? retryQuery.eq('id', agentId)
      : retryQuery.eq('is_default', true)
    ;({ data, error } = await retryQuery.maybeSingle())
  }

  if (error) throw error
  if (!data) return null

  const row = data as AiConfigRow
  // The Playground passes requireActive:false so an admin can test the
  // agent before flipping the master switch on.
  if (requireActive && !row.is_active) return null
  // Defensive: the column is NOT NULL, but a partial write / manual DB
  // edit could leave it empty. Treat a missing key as "not configured"
  // rather than letting decrypt() throw on null.
  if (!row.api_key) return null

  // The embeddings key is optional and independent of the chat key —
  // a corrupt/undecryptable one should downgrade to lexical KB, not
  // take down draft/auto-reply, so decrypt failures are swallowed here.
  let embeddingsApiKey: string | null = null
  if (row.embeddings_api_key) {
    try {
      embeddingsApiKey = decrypt(row.embeddings_api_key)
    } catch {
      // Not silent — a rotated/mismatched ENCRYPTION_KEY here means
      // semantic search quietly stops working, so leave a breadcrumb.
      console.error(
        `[ai config] embeddings key for account ${accountId} could not be decrypted — check ENCRYPTION_KEY; semantic search is disabled until it is re-entered.`,
      )
      embeddingsApiKey = null
    }
  }

  return {
    id: row.id,
    provider: row.provider,
    model: row.model,
    apiKey: decrypt(row.api_key),
    systemPrompt: row.system_prompt,
    isActive: row.is_active,
    autoReplyEnabled: row.auto_reply_enabled,
    autoReplyMaxPerConversation: row.auto_reply_max_per_conversation,
    handoffAgentId: row.handoff_agent_id,
    embeddingsApiKey,
    fallbacks: decryptFallbacks(accountId, row.fallbacks),
    agendaEnabled: row.agenda_enabled ?? false,
    handoffKeywords: row.handoff_keywords ?? [],
    transcriptionModel: parseTranscriptionModel(row.transcription_model),
  }
}

/**
 * Load + decrypt just the embeddings key, independent of `is_active`.
 * Used by the knowledge-base ingest routes so the KB gets embedded (and
 * semantic search works) whenever an embeddings key is present, even if
 * the assistant's master switch is currently off.
 *
 * Returns `{ key, corrupt }`: `key` is null when there's no key OR it
 * can't be decrypted; `corrupt` distinguishes those cases so callers can
 * warn ("a key is set but unusable") rather than silently indexing
 * lexical-only and reporting success.
 */
export async function loadEmbeddingsKey(
  db: SupabaseClient,
  accountId: string,
): Promise<{ key: string | null; corrupt: boolean }> {
  // Scoped to the default agent (multi-agent, migration 066) — the
  // knowledge base stays account-wide/shared (non-goal in
  // specs/multi-agent-router.md), and its embeddings key lives on
  // that one row. Without this scope, an account with a 2nd agent
  // would have `.maybeSingle()` error on >1 matching row.
  const { data, error } = await db
    .from('ai_configs')
    .select('embeddings_api_key')
    .eq('account_id', accountId)
    .eq('is_default', true)
    .maybeSingle()
  if (error || !data?.embeddings_api_key) return { key: null, corrupt: false }
  try {
    return { key: decrypt(data.embeddings_api_key), corrupt: false }
  } catch {
    console.error(
      `[ai config] embeddings key for account ${accountId} could not be decrypted — check ENCRYPTION_KEY.`,
    )
    return { key: null, corrupt: true }
  }
}

/**
 * List every agent on the account (specs/multi-agent-router.md) — no
 * keys, just enough for the agents list screen and a router's agent
 * picker. Ordered oldest-first so the default agent (always the
 * first one created, pre-multi-agent) sorts first by default.
 */
export async function listAiAgents(
  db: SupabaseClient,
  accountId: string,
): Promise<AiAgentSummary[]> {
  const { data, error } = await db
    .from('ai_configs')
    .select('id, name, provider, model, is_default, is_active')
    .eq('account_id', accountId)
    .order('created_at', { ascending: true })
  if (error) throw error
  return (data ?? []).map((row) => ({
    id: row.id,
    name: row.name,
    provider: row.provider,
    model: row.model,
    isDefault: row.is_default,
    isActive: row.is_active,
  }))
}
