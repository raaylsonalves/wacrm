import type { SupabaseClient } from '@supabase/supabase-js'

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
