import {
  AiError,
  type AiConfig,
  type AiProviderCredentials,
  type ChatMessage,
  type GenerateResult,
  type ToolDefinition,
  type ToolExecutor,
} from './types'
import { generateReply } from './generate'

// ============================================================
// Provider/model fallback chain (specs/ai-provider-fallback-chain.md).
//
// A transient provider outage (Gemini 503, a network blip) or an
// exhausted rate limit must not silently drop the auto-reply — try the
// account's configured fallback tiers, in order, before giving up.
// ============================================================

/** Error codes worth a short in-tier retry before giving up on that
 *  tier — genuinely transient blips. `rate_limited` is deliberately
 *  excluded: retrying against a quota that's already exhausted just
 *  burns the backoff window, so it skips straight to the next tier.
 *  `invalid_key` is excluded too — a bad key isn't fixed by retrying. */
const RETRYABLE_CODES = new Set(['provider_error', 'timeout', 'network_error'])

/** One retry (2 attempts total) per tier — enough to ride out a blip
 *  without adding noticeable latency to the customer-facing reply. */
const RETRY_DELAYS_MS = [1500]

export interface FallbackAttempt {
  provider: string
  model: string
  error: AiError
}

export interface FallbackResult extends GenerateResult {
  /** Which tier actually produced this result. */
  provider: AiConfig['provider']
  model: string
  /** Failed attempts that preceded the successful tier, if any — empty
   *  when the primary tier succeeded on the first try. */
  attempts: FallbackAttempt[]
}

/** Thrown when the primary provider and every configured fallback tier
 *  failed. Carries every attempt so the caller can build a handoff note
 *  explaining what was tried. */
export class AllProvidersFailedError extends Error {
  readonly attempts: FallbackAttempt[]
  constructor(attempts: FallbackAttempt[]) {
    super('All configured AI providers failed')
    this.name = 'AllProvidersFailedError'
    this.attempts = attempts
  }
}

function toAiError(err: unknown): AiError {
  if (err instanceof AiError) return err
  const message = err instanceof Error ? err.message : String(err)
  return new AiError(message, { code: 'unknown_error', status: 502 })
}

/**
 * Try the primary provider/model, then each configured fallback tier,
 * in order. Within a tier, retries `RETRYABLE_CODES` failures once with
 * a short backoff before advancing; `rate_limited` and `invalid_key`
 * advance immediately (see the constants above for why). Throws
 * `AllProvidersFailedError` — never a bare `AiError` — when every tier
 * is exhausted, so callers can distinguish "nothing worked" from a
 * single-provider `AiError` and reach for their own handling of that.
 *
 * `deps` exists purely for tests: `generate` swaps in a mock instead of
 * hitting a real provider, `delay` collapses the backoff to nothing.
 */
export async function generateReplyWithFallback(
  args: {
    config: AiConfig
    systemPrompt: string
    messages: ChatMessage[]
    /** Agenda tools (specs/ai-agenda-tool-calling.md) — forwarded to
     *  every tier tried, primary and fallbacks alike. */
    tools?: ToolDefinition[]
    executeTool?: ToolExecutor
  },
  deps: {
    generate?: typeof generateReply
    delay?: (ms: number) => Promise<void>
  } = {},
): Promise<FallbackResult> {
  const { config, systemPrompt, messages, tools, executeTool } = args
  const generate = deps.generate ?? generateReply
  const delay = deps.delay ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))

  const tiers: AiProviderCredentials[] = [
    { provider: config.provider, model: config.model, apiKey: config.apiKey },
    ...config.fallbacks,
  ]

  const attempts: FallbackAttempt[] = []

  for (const tier of tiers) {
    const maxAttempts = 1 + RETRY_DELAYS_MS.length
    let lastError: AiError | null = null

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const result = await generate({
          config: { ...config, provider: tier.provider, model: tier.model, apiKey: tier.apiKey },
          systemPrompt,
          messages,
          tools,
          executeTool,
        })
        return { ...result, provider: tier.provider, model: tier.model, attempts }
      } catch (err) {
        const aiError = toAiError(err)
        lastError = aiError
        const retryable = RETRYABLE_CODES.has(aiError.code)
        const hasMoreAttempts = attempt < maxAttempts - 1
        if (!retryable || !hasMoreAttempts) break
        await delay(RETRY_DELAYS_MS[attempt])
      }
    }

    attempts.push({ provider: tier.provider, model: tier.model, error: lastError! })
  }

  throw new AllProvidersFailedError(attempts)
}
