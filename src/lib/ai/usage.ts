import type { SupabaseClient } from '@supabase/supabase-js'
import type { AiProvider, AiUsage } from './types'

export interface LogAiUsageArgs {
  accountId: string
  /** Null for a draft not tied to one thread, or when the row was
   *  deleted between generation and logging. */
  conversationId: string | null
  /** The agent (`ai_configs.id`) whose config produced the call, so usage
   *  can be read per agent. Null for rows we can't attribute. */
  agentId?: string | null
  mode: 'auto_reply' | 'draft'
  provider: AiProvider
  model: string
  /** Provider usage; a no-op when null (nothing worth recording) unless
   *  `speechChars` is set. */
  usage: AiUsage | null
  /** 'chat' (default) | 'transcription' | 'speech' (migration 080). */
  kind?: 'chat' | 'transcription' | 'speech'
  /** Characters spoken (speech rows; billed per character). */
  speechChars?: number
}

/**
 * Best-effort append to `ai_usage_log` — one row per LLM call, for cost
 * visibility on the account's BYO key. NEVER throws: usage accounting
 * must not fail a reply the customer is waiting on, so any DB error is
 * logged and swallowed. Skips entirely when the provider didn't report
 * usage (we'd only be writing zeros).
 *
 * Pass the service-role admin client from the webhook, or the RLS-scoped
 * SSR client from a route — writes land either way (there's no
 * `authenticated` INSERT policy, so an SSR write relies on the service
 * role; callers that must persist from a route should pass the admin
 * client).
 */
export async function logAiUsage(
  db: SupabaseClient,
  args: LogAiUsageArgs,
): Promise<void> {
  if (!args.usage && !args.speechChars) return
  const kind = args.kind ?? 'chat'
  try {
    const row = {
      account_id: args.accountId,
      conversation_id: args.conversationId,
      agent_id: args.agentId ?? null,
      mode: args.mode,
      provider: args.provider,
      model: args.model,
      prompt_tokens: args.usage?.promptTokens ?? 0,
      completion_tokens: args.usage?.completionTokens ?? 0,
      total_tokens: args.usage?.totalTokens ?? 0,
    }
    let { error } = await db.from('ai_usage_log').insert({
      ...row,
      // NULL = the provider did not say (never 0).
      cached_tokens: args.usage?.cachedTokens ?? null,
      // Only written for audio rows, so a chat row is unchanged in shape
      // and an unmigrated database still accepts it.
      ...(kind !== 'chat' ? { kind, speech_chars: args.speechChars ?? null } : {}),
    })
    // Migration 078 not applied yet: keep the spend row rather than lose it.
    if (error && (error as { code?: string }).code === '42703') {
      // An audio row on a database without migration 080 would read as
      // chat spend; drop it rather than mislabel it.
      if (kind !== 'chat') return
      ;({ error } = await db.from('ai_usage_log').insert(row))
    }
    if (error) {
      console.error('[ai usage] log insert failed:', error)
    }
  } catch (err) {
    console.error('[ai usage] log insert threw:', err)
  }
}
