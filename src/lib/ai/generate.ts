import {
  AiError,
  type AiConfig,
  type AiUsage,
  type ChatMessage,
  type GenerateResult,
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
}

/**
 * Generate the next reply from the account's configured provider.
 * Dispatches to the right adapter, then parses the handoff sentinel out
 * of the raw text. Throws `AiError` on any provider/network failure.
 */
export async function generateReply(args: GenerateArgs): Promise<GenerateResult> {
  const { config, systemPrompt, messages } = args
  const timeoutMs = aiRequestTimeoutMs()
  const providerArgs = {
    apiKey: config.apiKey,
    model: config.model,
    systemPrompt,
    messages,
    timeoutMs,
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
 * on `MULTI_MESSAGE_DELIMITER` into `segments` — auto-reply mode's
 * system prompt is the only one that teaches the model to emit it (see
 * `buildSystemPrompt`), so draft/playground callers just get `[text]`
 * back. A model that ignores the segment cap has its overflow merged
 * into the last segment rather than dropped, so no content is lost.
 */
export function parseGeneration(
  raw: string,
  usage: AiUsage | null = null,
): GenerateResult {
  const handoff = raw.includes(HANDOFF_SENTINEL)
  const text = raw.split(HANDOFF_SENTINEL).join('').trim()

  const rawSegments = text
    .split(MULTI_MESSAGE_DELIMITER)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)

  let segments = rawSegments
  if (rawSegments.length > MAX_REPLY_SEGMENTS) {
    const head = rawSegments.slice(0, MAX_REPLY_SEGMENTS - 1)
    const overflow = rawSegments.slice(MAX_REPLY_SEGMENTS - 1).join('\n\n')
    segments = [...head, overflow]
  }

  return { text, segments, handoff, usage }
}
