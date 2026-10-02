import type { SupabaseClient } from '@supabase/supabase-js'
import { loadAiConfig } from './config'
import type { AiConfig } from './types'

/**
 * The agent bound to a number, or null when the number has none
 * (specs/ai-agents-management.md; migration 074).
 *
 * `channelId` follows the repo-wide convention: NULL is the account's
 * Cloud API number, a uuid is a WAHA channel.
 *
 * Never throws: a lookup failure reads as "no binding", so the caller
 * falls straight through to the router / default agent — a hiccup here
 * must not silence a customer's reply.
 */
export async function loadChannelAgentId(
  db: SupabaseClient,
  accountId: string,
  channelId: string | null,
): Promise<string | null> {
  try {
    let query = db
      .from('ai_channel_agents')
      .select('agent_id')
      .eq('account_id', accountId)
    query = channelId ? query.eq('channel_id', channelId) : query.is('channel_id', null)
    const { data, error } = await query.maybeSingle()
    if (error || !data) return null
    return (data as { agent_id: string }).agent_id
  } catch {
    return null
  }
}

/**
 * The agent that owns a conversation: the one pinned to it, else the one
 * bound to its number. Null when neither exists.
 */
export async function loadConversationAgentId(
  db: SupabaseClient,
  accountId: string,
  conversationId: string,
): Promise<string | null> {
  try {
    const { data: conv } = await db
      .from('conversations')
      .select('whatsapp_channel_id, pinned_ai_agent_id')
      .eq('id', conversationId)
      .eq('account_id', accountId)
      .maybeSingle()
    if (!conv) return null
    return (
      (conv.pinned_ai_agent_id as string | null) ??
      (await loadChannelAgentId(db, accountId, (conv.whatsapp_channel_id as string | null) ?? null))
    )
  } catch {
    return null
  }
}

/**
 * The account's default agent, or — when it is off or missing — the
 * conversation's own agent (pinned or bound to the number). Switching the
 * default off must not leave a number's agent unusable for auto-reply,
 * drafts or summaries (seen live with a demo agent bound to the number).
 */
export async function loadAgentForConversation(
  db: SupabaseClient,
  accountId: string,
  conversationId: string,
): Promise<AiConfig | null> {
  const fallback = await loadAiConfig(db, accountId)
  if (fallback) return fallback
  const agentId = await loadConversationAgentId(db, accountId, conversationId)
  return agentId ? loadAiConfig(db, accountId, { agentId }) : null
}
