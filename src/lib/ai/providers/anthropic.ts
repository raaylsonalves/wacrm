import { AiError, type ChatMessage, type ProviderResult, type ToolDefinition } from '../types'
import { MAX_OUTPUT_TOKENS } from '../defaults'
import {
  mergeConsecutive,
  normalizeUsage,
  providerHttpError,
  toNetworkError,
  MAX_TOOL_ROUNDS,
  type ProviderArgs,
} from './shared'

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'
const ANTHROPIC_VERSION = '2023-06-01'

interface AnthropicContentBlock {
  type?: string
  text?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
}

interface AnthropicResponse {
  content?: AnthropicContentBlock[]
  usage?: { input_tokens?: number; output_tokens?: number }
}

/**
 * Anthropic's Messages API requires strictly alternating roles that
 * begin with `user`. Merge consecutive turns, then drop any leading
 * assistant turns (an agent greeting before the customer said anything)
 * so the transcript always starts on the customer. Guarantees a valid,
 * non-empty payload.
 */
function normalizeForAnthropic(messages: ChatMessage[]): ChatMessage[] {
  const merged = mergeConsecutive(messages)
  while (merged.length > 0 && merged[0].role === 'assistant') {
    merged.shift()
  }
  if (merged.length === 0) {
    return [{ role: 'user', content: '(The customer has not sent a message yet.)' }]
  }
  return merged
}

function toAnthropicTools(tools: ToolDefinition[]) {
  return tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }))
}

/**
 * Call Anthropic's Messages endpoint with the caller's own key.
 * Returns the raw assistant text + token usage (handoff parsing happens
 * in `generateReply`). When `tools`/`executeTool` are supplied, runs its
 * own bounded tool-calling loop (see `MAX_TOOL_ROUNDS`): a response
 * whose content includes `tool_use` blocks is answered by executing each
 * one and re-posting the assistant's own content back verbatim plus one
 * user turn carrying a `tool_result` block per call, until the model
 * returns plain text only.
 */
export async function generateAnthropic(args: ProviderArgs): Promise<ProviderResult> {
  const { apiKey, model, systemPrompt, messages, timeoutMs, tools, executeTool } = args

  const body: Record<string, unknown>[] = normalizeForAnthropic(messages).map((m) => ({
    role: m.role,
    content: m.content,
  }))

  // `timeoutMs` is a TOTAL budget for the whole exchange, not per
  // request — see the matching comment in providers/openai.ts.
  const deadline = Date.now() + timeoutMs

  const call = async (): Promise<AnthropicResponse> => {
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      throw new AiError('The AI provider took too long to respond.', {
        code: 'timeout',
        status: 504,
      })
    }
    let res: Response
    try {
      res = await fetch(ANTHROPIC_URL, {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          system: systemPrompt,
          max_tokens: MAX_OUTPUT_TOKENS,
          messages: body,
          ...(tools && tools.length > 0 ? { tools: toAnthropicTools(tools) } : {}),
        }),
        signal: AbortSignal.timeout(remaining),
      })
    } catch (err) {
      throw toNetworkError(err)
    }
    if (!res.ok) throw await providerHttpError('Anthropic', res)
    const data = (await res.json().catch(() => null)) as AnthropicResponse | null
    if (!data) {
      throw new AiError('Anthropic returned an unparsable response.', { code: 'empty_response' })
    }
    return data
  }

  let usage: ReturnType<typeof normalizeUsage> = null
  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const data = await call()
    usage = normalizeUsage({
      prompt: data.usage?.input_tokens,
      completion: data.usage?.output_tokens,
    })

    const content = data.content ?? []
    const toolUses = content.filter((b) => b.type === 'tool_use')
    if (tools && tools.length > 0) {
      console.info(
        `[ai anthropic] round ${round}: ${toolUses.length} tool call(s)`,
        toolUses.map((b) => b.name),
      )
    }

    if (toolUses.length > 0 && executeTool && round < MAX_TOOL_ROUNDS) {
      body.push({ role: 'assistant', content })
      const resultBlocks = []
      for (const use of toolUses) {
        const result = await executeTool(use.name ?? '', use.input ?? {})
        resultBlocks.push({ type: 'tool_result', tool_use_id: use.id, content: result })
      }
      body.push({ role: 'user', content: resultBlocks })
      continue
    }

    const text = content
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('')
      .trim()
    if (!text) {
      throw new AiError('Anthropic returned an empty response.', { code: 'empty_response' })
    }
    return { text, usage }
  }

  throw new AiError('Anthropic kept calling tools without answering.', { code: 'empty_response' })
}
