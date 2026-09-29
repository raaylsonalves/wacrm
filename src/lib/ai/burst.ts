// ============================================================
// Burst coalescing (specs/ai-token-economy.md, lever 2).
//
// A customer often sends three short messages in a few seconds. Each
// inbound used to start its own paid reply. Now every dispatch waits a
// short quiet period and only the one whose message is STILL the newest
// answers — with the whole burst in its context, once.
//
// No queue or cron: the waiting dispatch is the webhook's own `after()`
// work, and the check is "is there a newer customer message?". If a
// process dies mid-wait the message goes unanswered until the customer
// writes again (the same exposure the AI path has for any in-flight
// reply); the wait is short to keep that window small.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

const DEFAULT_DEBOUNCE_MS = 4_000
const MAX_DEBOUNCE_MS = 15_000

/** Quiet period before answering. `AI_REPLY_DEBOUNCE_MS=0` turns it off. */
export function aiReplyDebounceMs(): number {
  const raw = process.env.AI_REPLY_DEBOUNCE_MS
  if (raw === undefined || raw === '') return DEFAULT_DEBOUNCE_MS
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return DEFAULT_DEBOUNCE_MS
  return Math.min(Math.floor(n), MAX_DEBOUNCE_MS)
}

async function newestCustomerMessageId(
  db: SupabaseClient,
  conversationId: string,
): Promise<string | null> {
  const { data } = await db
    .from('messages')
    .select('id')
    .eq('conversation_id', conversationId)
    .eq('sender_type', 'customer')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  return (data as { id: string } | null)?.id ?? null
}

/** The row id of the message this dispatch was started for, so a later
 *  message that arrived BEFORE we looked is still recognised as newer. */
async function ownMessageId(
  db: SupabaseClient,
  conversationId: string,
  wamid: string | undefined,
): Promise<string | null> {
  if (wamid) {
    const { data } = await db
      .from('messages')
      .select('id')
      .eq('conversation_id', conversationId)
      .eq('message_id', wamid)
      .maybeSingle()
    const id = (data as { id: string } | null)?.id
    if (id) return id
  }
  return newestCustomerMessageId(db, conversationId)
}

export type QuietResult = 'proceed' | 'superseded'

/**
 * Wait, then say whether this dispatch should answer. 'superseded' means a
 * newer customer message arrived — its own dispatch will answer with this
 * one in context. Fails OPEN: any lookup problem answers rather than
 * silently dropping the customer.
 */
export async function waitForQuietPeriod(
  db: SupabaseClient,
  args: {
    conversationId: string
    /** Meta's wamid of the message that started this dispatch, when known. */
    inboundMessageId?: string
    ms?: number
    sleep?: (ms: number) => Promise<void>
  },
): Promise<QuietResult> {
  const ms = args.ms ?? aiReplyDebounceMs()
  if (ms <= 0) return 'proceed'
  const sleep = args.sleep ?? ((t: number) => new Promise<void>((r) => setTimeout(r, t)))

  try {
    const mine = await ownMessageId(db, args.conversationId, args.inboundMessageId)
    await sleep(ms)
    const newest = await newestCustomerMessageId(db, args.conversationId)
    if (mine && newest && newest !== mine) return 'superseded'
    return 'proceed'
  } catch (err) {
    console.warn('[ai burst] quiet-period check failed, answering now:', err)
    return 'proceed'
  }
}
