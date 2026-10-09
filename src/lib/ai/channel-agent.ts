import type { SupabaseClient } from '@supabase/supabase-js'
import { loadAiConfig } from './config'
import type { AiConfig } from './types'
import { primaryConfigId } from '@/lib/whatsapp/conversation-number'

/**
 * The agent bound to a number, or null when the number has none
 * (specs/ai-agents-management.md; migration 074).
 *
 * `channelId` follows the repo-wide convention: NULL is the official
 * (Cloud API) side, a uuid is a WAHA channel. On the official side,
 * `configId` names WHICH official number (migration 114): its own binding
 * wins, then the legacy account-wide "Cloud API" row. NULL configId is
 * the primary number.
 *
 * Never throws: a lookup failure reads as "no binding", so the caller
 * falls straight through to the router / default agent — a hiccup here
 * must not silence a customer's reply.
 */
export async function loadChannelAgentId(
  db: SupabaseClient,
  accountId: string,
  channelId: string | null,
  configId: string | null = null,
): Promise<string | null> {
  try {
    if (channelId) {
      const { data, error } = await db
        .from('ai_channel_agents')
        .select('agent_id')
        .eq('account_id', accountId)
        .eq('channel_id', channelId)
        .maybeSingle()
      if (error || !data) return null
      return (data as { agent_id: string }).agent_id
    }
    const numberId = configId ?? (await primaryConfigId(db, accountId))
    if (numberId) {
      const { data } = await db
        .from('ai_channel_agents')
        .select('agent_id')
        .eq('account_id', accountId)
        .is('channel_id', null)
        .eq('whatsapp_config_id', numberId)
        .maybeSingle()
      if (data) return (data as { agent_id: string }).agent_id
    }
    const { data: legacy } = await db
      .from('ai_channel_agents')
      .select('agent_id')
      .eq('account_id', accountId)
      .is('channel_id', null)
      .is('whatsapp_config_id', null)
      .maybeSingle()
    return (legacy as { agent_id: string } | null)?.agent_id ?? null
  } catch {
    return null
  }
}

/**
 * The agent that owns a conversation: the one pinned to it, else the one
 * a sticky router chose for it, else the one bound to its number. Null
 * when none exists. Same order as the auto-reply (minus classification,
 * which needs a fresh customer message).
 */
export async function loadConversationAgentId(
  db: SupabaseClient,
  accountId: string,
  conversationId: string,
): Promise<string | null> {
  try {
    const { data: conv } = await db
      .from('conversations')
      .select('whatsapp_channel_id, whatsapp_config_id, pinned_ai_agent_id, active_ai_agent_id')
      .eq('id', conversationId)
      .eq('account_id', accountId)
      .maybeSingle()
    if (!conv) return null
    return (
      (conv.pinned_ai_agent_id as string | null) ??
      (conv.active_ai_agent_id as string | null) ??
      (await loadChannelAgentId(
        db,
        accountId,
        (conv.whatsapp_channel_id as string | null) ?? null,
        (conv.whatsapp_config_id as string | null) ?? null,
      ))
    )
  } catch {
    return null
  }
}

/**
 * The agent that speaks for this conversation outside a live reply —
 * drafts, summaries, AI follow-ups: its own agent (pinned, router-chosen
 * or bound to the number), else the account's default. The persona the
 * customer has been talking to, not the default one (A7).
 */
export async function loadAgentForConversation(
  db: SupabaseClient,
  accountId: string,
  conversationId: string,
): Promise<AiConfig | null> {
  const agentId = await loadConversationAgentId(db, accountId, conversationId)
  if (agentId) {
    const own = await loadAiConfig(db, accountId, { agentId })
    if (own) return own
  }
  return loadAiConfig(db, accountId)
}
