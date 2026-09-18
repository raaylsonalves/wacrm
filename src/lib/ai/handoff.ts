import type { ChatMessage } from './types'

/** Longest the quoted customer message runs before we ellipsize it —
 *  keeps the internal note to a glanceable one-liner. */
const MAX_QUOTE_LEN = 160

/**
 * Build the short internal note the auto-reply bot leaves on a
 * conversation when it hands off to a human. Deterministic — composed
 * from context we already have (no extra LLM call / token spend), so it
 * can't fail or add latency to the handoff.
 *
 * Reads as, e.g.:
 *   "🤖 AI agent handed off after 2 replies. Last customer message:
 *    “can I speak to a manager about my refund?”"
 *
 * `replyCount` is the bot's auto-reply tally for the thread (0 when it
 * bailed on the very first inbound without answering).
 */
export function buildHandoffSummary(args: {
  messages: ChatMessage[]
  replyCount: number
}): string {
  const { messages, replyCount } = args

  const lastCustomer = [...messages]
    .reverse()
    .find((m) => m.role === 'user' && m.content.trim())

  const replies =
    replyCount === 0
      ? 'without replying'
      : `after ${replyCount} ${replyCount === 1 ? 'reply' : 'replies'}`

  const base = `🤖 AI agent handed off ${replies}.`

  if (!lastCustomer) return base

  const quote = truncate(lastCustomer.content.trim(), MAX_QUOTE_LEN)
  return `${base} Last customer message: “${quote}”`
}

function truncate(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, ' ')
  if (collapsed.length <= max) return collapsed
  return `${collapsed.slice(0, max - 1).trimEnd()}…`
}

/** Human-readable label for an `AiError.code`, used in the failure note
 *  below — short enough to read at a glance in the inbox. */
function describeFailureCode(code: string): string {
  switch (code) {
    case 'rate_limited':
      return 'rate limited'
    case 'timeout':
      return 'timed out'
    case 'invalid_key':
      return 'invalid key'
    case 'network_error':
      return 'network error'
    default:
      return 'unavailable'
  }
}

/**
 * Build the internal note left when every configured AI provider/model
 * tier failed (see `generateReplyWithFallback` in
 * `generate-with-fallback.ts`) and auto-reply hands the conversation to
 * a human as a result — a distinct cause from `buildHandoffSummary`'s
 * "the model chose to hand off", so it gets its own note explaining
 * which providers were tried and why each one failed.
 *
 * Reads as, e.g.:
 *   "🤖 AI unavailable after trying 2 providers: gemini (unavailable),
 *    anthropic (timed out) — transferred automatically."
 */
export function buildProviderFailureSummary(args: {
  attempts: { provider: string; model: string; error: { code: string } }[]
}): string {
  const { attempts } = args
  const tried = attempts
    .map((a) => `${a.provider} (${describeFailureCode(a.error.code)})`)
    .join(', ')
  const count = attempts.length
  return `🤖 AI unavailable after trying ${count} ${count === 1 ? 'provider' : 'providers'}: ${tried} — transferred automatically.`
}

/**
 * Build the internal note left when the per-conversation auto-reply
 * cap (`auto_reply_max_per_conversation`) is reached and auto-reply
 * hands the conversation to a human as a result — the third distinct
 * cause alongside `buildHandoffSummary` (model-initiated) and
 * `buildProviderFailureSummary` (every provider failed).
 */
export function buildCapReachedSummary(args: { max: number }): string {
  return `🤖 AI reply limit reached (${args.max} replies in this conversation) — transferred automatically.`
}
