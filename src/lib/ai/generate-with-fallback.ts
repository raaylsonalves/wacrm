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
import { aiRequestTimeoutMs } from './defaults'

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

/**
 * Hard ceiling on the WHOLE fallback chain — every tier, every retry,
 * combined — not just one call. Each `generate()` call already caps
 * itself at its own `timeoutMs` (see the "TOTAL budget" comment in
 * providers/openai.ts), but with 2 tiers x up to 2 attempts each, that
 * alone still allows up to ~4x a single call's timeout in the worst
 * case — comfortably over the auto-reply webhook route's 60s
 * maxDuration, which is exactly what let a real dispatch get killed by
 * Vercel's hard timeout with no reply ever sent and no error caught
 * anywhere (specs/ai-agenda-tool-calling.md's reported regression).
 * Sized to leave real headroom under 60s for everything else the
 * webhook does before and after this call.
 */
const OVERALL_BUDGET_MS = 35_000

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

  // A tool call is a real side effect (a WhatsApp send, an appointment
  // write) — NOT idempotent, unlike a plain text generation. Retrying
  // the same tier or advancing to a fallback tier re-runs the whole
  // exchange from scratch with the model's original messages, so if it
  // decides to call the same tool again, that side effect fires twice.
  // Confirmed live: a tool ran successfully, that attempt then failed on
  // a LATER round, and the fallback tier's own fresh attempt called the
  // same tool again — the customer got two duplicate WhatsApp slot
  // lists before the final confirmation. Track whether any tool has
  // fired yet and, once it has, stop the chain outright on any further
  // failure instead of retrying/advancing — a handoff is a far better
  // outcome than a duplicated side effect.
  let toolSideEffectFired = false
  const trackedExecuteTool: ToolExecutor | undefined = executeTool
    ? async (name, toolArgs) => {
        toolSideEffectFired = true
        return executeTool(name, toolArgs)
      }
    : undefined

  const tiers: AiProviderCredentials[] = [
    { provider: config.provider, model: config.model, apiKey: config.apiKey },
    ...config.fallbacks,
  ]

  const attempts: FallbackAttempt[] = []
  const defaultTimeoutMs = aiRequestTimeoutMs()
  const chainDeadline = Date.now() + OVERALL_BUDGET_MS
  const budgetExceededError = () =>
    new AiError('Ran out of the overall AI reply time budget.', { code: 'timeout', status: 504 })

  outer: for (const tier of tiers) {
    const maxAttempts = 1 + RETRY_DELAYS_MS.length
    let lastError: AiError | null = null

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const remaining = chainDeadline - Date.now()
      if (remaining <= 0) {
        // The chain-wide budget is spent — stop trying entirely rather
        // than starting an attempt with (or without) a shrinking
        // timeout that would push the whole dispatch past the
        // webhook route's 60s maxDuration with no result either way.
        lastError = budgetExceededError()
        attempts.push({ provider: tier.provider, model: tier.model, error: lastError })
        break outer
      }
      try {
        const result = await generate({
          config: { ...config, provider: tier.provider, model: tier.model, apiKey: tier.apiKey },
          systemPrompt,
          messages,
          tools,
          executeTool: trackedExecuteTool,
          // Never hand an attempt more time than the chain has left —
          // a late attempt with a full fresh timeout is exactly how 2
          // tiers x 2 attempts each blew past 60s with nothing caught.
          timeoutMs: Math.min(defaultTimeoutMs, remaining),
        })
        return { ...result, provider: tier.provider, model: tier.model, attempts }
      } catch (err) {
        const aiError = toAiError(err)
        lastError = aiError
        if (toolSideEffectFired) {
          attempts.push({ provider: tier.provider, model: tier.model, error: aiError })
          break outer
        }
        const retryable = RETRYABLE_CODES.has(aiError.code)
        const hasMoreAttempts = attempt < maxAttempts - 1
        const timeForRetryDelay =
          hasMoreAttempts && chainDeadline - Date.now() > RETRY_DELAYS_MS[attempt]
        if (!retryable || !hasMoreAttempts || !timeForRetryDelay) break
        await delay(RETRY_DELAYS_MS[attempt])
      }
    }

    attempts.push({ provider: tier.provider, model: tier.model, error: lastError! })
  }

  throw new AllProvidersFailedError(attempts)
}
