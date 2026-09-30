import type { ChatMessage } from './types'

/**
 * Why the auto-reply bot stopped on a conversation. Stored in
 * `conversations.ai_handoff_reason` (CHECK in migration 072) and
 * rendered localized by the inbox banner — the server never writes a
 * finished sentence, because the app is build-time single-locale and a
 * hard-coded English note could not be translated.
 */
export type HandoffReason =
  | 'model_requested'
  | 'reply_cap'
  | 'provider_failure'
  | 'empty_reply'
  | 'rate_limited'
  | 'system_error'
  | 'customer_requested_human'
  | 'audio_unintelligible'
  | 'case_escalated'

/** Structured, non-translated facts stored in `ai_handoff_meta`. */
export interface HandoffMeta {
  /** The bot's auto-reply tally for the thread when it stopped. */
  replyCount?: number
  /** The per-conversation cap in force (reply_cap only). */
  max?: number
  /** What the customer last wrote — the one thing the human needs. */
  lastCustomerMessage?: string
  /** Providers tried and the `AiError.code` each failed with. */
  attempts?: { provider: string; code: string }[]
}

/** Longest the stored customer quote runs. The banner clamps it to a few
 *  lines and offers "show more", so this only bounds row size. */
const MAX_QUOTE_LEN = 500

/** Most recent non-empty customer message in the model context, with
 *  whitespace collapsed. Null when there is none (the bot bailed on an
 *  attachment-only thread). */
export function lastCustomerMessage(messages: ChatMessage[]): string | null {
  const last = [...messages]
    .reverse()
    .find((m) => m.role === 'user' && m.content.trim())
  if (!last) return null
  const collapsed = last.content.replace(/\s+/g, ' ').trim()
  if (collapsed.length <= MAX_QUOTE_LEN) return collapsed
  return `${collapsed.slice(0, MAX_QUOTE_LEN - 1).trimEnd()}…`
}

/**
 * Assemble the meta stored with a handoff. Deterministic — composed from
 * context we already have (no LLM call), so it can't fail or add latency
 * to the handoff. Keys with no value are omitted rather than stored null.
 */
export function buildHandoffMeta(args: {
  messages?: ChatMessage[]
  replyCount?: number
  max?: number
  attempts?: { provider: string; error: { code: string } }[]
}): HandoffMeta {
  const meta: HandoffMeta = {}
  if (args.replyCount !== undefined) meta.replyCount = args.replyCount
  if (args.max !== undefined) meta.max = args.max
  const quote = args.messages ? lastCustomerMessage(args.messages) : null
  if (quote) meta.lastCustomerMessage = quote
  if (args.attempts && args.attempts.length > 0) {
    meta.attempts = args.attempts.map((a) => ({
      provider: a.provider,
      code: a.error.code,
    }))
  }
  return meta
}
