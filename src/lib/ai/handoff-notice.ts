// ============================================================
// The message the customer gets when the AI stops answering
// (specs/handoff-customer-notice.md).
//
// Ported in spirit from deskcomm's aviso-ao-lead, which exists because
// a measured production failure: the customer asked for a person and
// then got silence. Every rule below has a failure behind it.
//
// Pure — no I/O — so it is unit-testable; the two small loaders at the
// bottom do the reading (dictionary, presence).
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { OFFLINE_AFTER_MS } from '@/lib/presence'
import { hashKey } from '@/lib/variant'

/** Variant lists for one locale, read from `AiHandoffNotice` in
 *  messages/<locale>.json. */
export interface HandoffNoticeDict {
  /** Somebody has the dashboard open — "a teammate will reply shortly". */
  online: string[]
  /** Nobody does — must not promise a quick answer to an empty office. */
  offline: string[]
  /** The customer asked to stop: confirm, don't say a person is coming. */
  optOut: string[]
}

// Shared with the follow-up sequences (same rule: stable per conversation).
export { hashKey }

/**
 * Pick the notice wording.
 *
 * - Reason-aware in one way that matters: an opt-out is confirmed and
 *   stops there ("a teammate will continue with you" is wrong for
 *   someone who wrote STOP).
 * - Availability-aware: never promise an instant reply when nobody is
 *   online.
 * - Variant chosen by hashing the conversation id: the same conversation
 *   always gets the same wording (a retry can't flip-flop), different
 *   conversations get different wording, so a busy account isn't
 *   sending one identical sentence hundreds of times — exactly what
 *   makes a WhatsApp number look automated.
 *
 * Returns null when the dictionary has no variant to offer, so a
 * missing translation degrades to "no notice" instead of sending a
 * raw key to a customer.
 */
export function handoffNoticeText(args: {
  optOut: boolean
  teamOnline: boolean
  /** Seed for the variant picker — the conversation id. */
  leadKey: string
  dict: HandoffNoticeDict
}): string | null {
  const pool = args.optOut
    ? args.dict.optOut
    : args.teamOnline
      ? args.dict.online
      : args.dict.offline
  if (pool.length === 0) return null
  return pool[hashKey(args.leadKey) % pool.length]
}

/** Read `AiHandoffNotice` for the deployment's locale (notices aren't
 *  React-rendered, so this reads the same dictionary
 *  src/i18n/request.ts loads — the pattern of lib/push/send.ts). */
export async function loadHandoffNoticeDict(
  locale: string = process.env.NEXT_PUBLIC_APP_LOCALE || 'en',
): Promise<HandoffNoticeDict> {
  const empty: HandoffNoticeDict = { online: [], offline: [], optOut: [] }
  try {
    const messages = (await import(`../../../messages/${locale}.json`)).default
    return dictFromMessages(messages?.AiHandoffNotice) ?? empty
  } catch {
    return empty
  }
}

export function dictFromMessages(node: unknown): HandoffNoticeDict | null {
  if (!node || typeof node !== 'object') return null
  const group = (key: string): string[] => {
    const g = (node as Record<string, unknown>)[key]
    if (!g || typeof g !== 'object') return []
    return Object.entries(g as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, v]) => v)
      .filter((v): v is string => typeof v === 'string' && v.trim() !== '')
  }
  return {
    online: group('online'),
    offline: group('offline'),
    optOut: group('optOut'),
  }
}

/**
 * Is at least one team member actively on the dashboard? A heuristic —
 * presence says someone has the app open, not that they will answer —
 * which is why the wording stays hedged either way. Same staleness
 * threshold the roster uses (`OFFLINE_AFTER_MS`). Any failure reads as
 * "nobody online": the safe side, since that copy promises less.
 */
export async function isTeamOnline(
  db: SupabaseClient,
  accountId: string,
): Promise<boolean> {
  try {
    const cutoff = new Date(Date.now() - OFFLINE_AFTER_MS).toISOString()
    const { data } = await db
      .from('member_presence')
      .select('user_id')
      .eq('account_id', accountId)
      .eq('status', 'online')
      .gte('last_seen_at', cutoff)
      .limit(1)
    return !!data && data.length > 0
  } catch {
    return false
  }
}
