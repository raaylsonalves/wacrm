import {
  AiError,
  type AiConfig,
  type AiUsage,
  type ChatMessage,
  type GenerateResult,
  type ToolDefinition,
  type ToolExecutor,
} from './types'
import {
  HANDOFF_SENTINEL,
  MULTI_MESSAGE_DELIMITER,
  MAX_REPLY_SEGMENTS,
  aiRequestTimeoutMs,
} from './defaults'
import { generateOpenAi } from './providers/openai'
import { generateAnthropic } from './providers/anthropic'
import { generateGemini } from './providers/gemini'

export interface GenerateArgs {
  config: AiConfig
  /** Fully-built system prompt (see `buildSystemPrompt`). */
  systemPrompt: string
  /** Recent conversation turns, oldest first. */
  messages: ChatMessage[]
  /** Agenda tools (specs/ai-agenda-tool-calling.md). Auto-reply only —
   *  draft/playground never pass these, since a tool call is a real
   *  side effect (a WhatsApp send, an appointment write) a human
   *  hasn't approved yet. */
  tools?: ToolDefinition[]
  executeTool?: ToolExecutor
  /** Override the default per-call timeout budget. Used by
   *  `generateReplyWithFallback` to shrink later attempts/tiers to
   *  whatever's left of its own overall deadline, rather than handing
   *  every attempt a full fresh timeout regardless of how much of the
   *  fallback chain's own budget is already spent. Defaults to
   *  `aiRequestTimeoutMs()`. */
  timeoutMs?: number
}

/**
 * Generate the next reply from the account's configured provider.
 * Dispatches to the right adapter, then parses the handoff sentinel out
 * of the raw text. Throws `AiError` on any provider/network failure.
 */
export async function generateReply(args: GenerateArgs): Promise<GenerateResult> {
  const { config, systemPrompt, messages, tools, executeTool } = args
  const timeoutMs = args.timeoutMs ?? aiRequestTimeoutMs()
  const providerArgs = {
    apiKey: config.apiKey,
    model: config.model,
    systemPrompt,
    messages,
    timeoutMs,
    tools,
    executeTool,
  }

  let result: { text: string; usage: AiUsage | null }
  switch (config.provider) {
    case 'openai':
      result = await generateOpenAi(providerArgs)
      break
    case 'anthropic':
      result = await generateAnthropic(providerArgs)
      break
    case 'gemini':
      result = await generateGemini(providerArgs)
      break
    default:
      throw new AiError(`Unsupported AI provider: ${config.provider}`, {
        code: 'unsupported_provider',
        status: 400,
      })
  }

  return parseGeneration(result.text, result.usage)
}

/**
 * Split the raw model output into `{ text, segments, handoff, usage }`.
 * The handoff sentinel can appear alone or trailing a partial reply;
 * either way we treat the turn as a handoff and strip the marker from
 * any remaining text. `usage` is passed straight through (null when
 * the provider didn't report it).
 *
 * After the handoff sentinel is stripped, the remaining text is split
 * on `MULTI_MESSAGE_DELIMITER` into `segments`. `text` is then rebuilt
 * as `segments.join('\n\n')` rather than kept as the raw stripped
 * string — the account's own business-context prompt is appended in
 * EVERY mode (not just auto-reply), so a custom prompt that mentions
 * the delimiter (to match the auto-reply persona) can make the model
 * emit it even in draft/playground calls that never split on it. A
 * `text` that still contained the literal token would leak straight
 * into a draft reply's compose box. Rebuilding it from `segments`
 * means every caller gets a clean, delimiter-free string by
 * construction, whether or not it uses `segments` itself.
 */
export function parseGeneration(
  raw: string,
  usage: AiUsage | null = null,
): GenerateResult {
  const handoff = raw.includes(HANDOFF_SENTINEL)
  const stripped = raw.split(HANDOFF_SENTINEL).join('').trim()

  const rawSegments = stripped
    .split(MULTI_MESSAGE_DELIMITER)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)

  let segments = rawSegments
  if (rawSegments.length > MAX_REPLY_SEGMENTS) {
    const head = rawSegments.slice(0, MAX_REPLY_SEGMENTS - 1)
    const overflow = rawSegments.slice(MAX_REPLY_SEGMENTS - 1).join('\n\n')
    segments = [...head, overflow]
  }

  const text = segments.length > 0 ? segments.join('\n\n') : stripped

  return { text, segments, handoff, usage }
}
