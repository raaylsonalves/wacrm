import { AiError, type ProviderResult, type ToolDefinition } from '../types'
import { MAX_OUTPUT_TOKENS } from '../defaults'
import {
  mergeConsecutive,
  normalizeUsage,
  providerHttpError,
  toNetworkError,
  MAX_TOOL_ROUNDS,
  type ProviderArgs,
} from './shared'

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'

interface OpenRouterToolCall {
  id: string
  function?: { name?: string; arguments?: string }
}

interface OpenRouterMessage {
  content?: string
  tool_calls?: OpenRouterToolCall[]
}

interface OpenRouterResponse {
  choices?: { message?: OpenRouterMessage }[]
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
  }
}

function toOpenRouterTools(tools: ToolDefinition[]) {
  return tools.map((t) => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }))
}

/**
 * Call OpenRouter's Chat Completions endpoint (an OpenAI-compatible
 * proxy in front of many models — including free-tier ones, e.g. its
 * "Free Models Router") with the caller's own key. Deliberately its own
 * file rather than a thin wrapper around providers/openai.ts, matching
 * the one-file-per-provider pattern in this directory — the two are
 * close but not identical (`max_tokens` here, not
 * `max_completion_tokens`, since not every model OpenRouter proxies to
 * recognizes OpenAI's o1-era param name).
 *
 * Returns the raw assistant text + token usage (handoff parsing happens
 * in `generateReply`). When `tools`/`executeTool` are supplied, runs its
 * own bounded tool-calling loop (see `MAX_TOOL_ROUNDS`) — most models
 * OpenRouter routes to support the same `tools`/`tool_calls` shape as
 * OpenAI; one that doesn't will simply never return `tool_calls`.
 */
export async function generateOpenRouter(args: ProviderArgs): Promise<ProviderResult> {
  const { apiKey, model, systemPrompt, messages, timeoutMs, tools, executeTool } = args

  const body: Record<string, unknown>[] = [
    { role: 'system', content: systemPrompt },
    ...mergeConsecutive(messages).map((m) => ({ role: m.role, content: m.content })),
  ]

  // `timeoutMs` is a TOTAL budget for the whole exchange, not per
  // request — see the matching comment in providers/openai.ts.
  const deadline = Date.now() + timeoutMs

  const call = async (): Promise<OpenRouterResponse> => {
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      throw new AiError('The AI provider took too long to respond.', {
        code: 'timeout',
        status: 504,
      })
    }
    let res: Response
    try {
      res = await fetch(OPENROUTER_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages: body,
          max_tokens: MAX_OUTPUT_TOKENS,
          ...(tools && tools.length > 0 ? { tools: toOpenRouterTools(tools) } : {}),
        }),
        signal: AbortSignal.timeout(remaining),
      })
    } catch (err) {
      throw toNetworkError(err)
    }
    if (!res.ok) throw await providerHttpError('OpenRouter', res)
    const data = (await res.json().catch(() => null)) as OpenRouterResponse | null
    if (!data) {
      throw new AiError('OpenRouter returned an unparsable response.', { code: 'empty_response' })
    }
    return data
  }

  let usage: ReturnType<typeof normalizeUsage> = null
  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const data = await call()
    usage = normalizeUsage({
      prompt: data.usage?.prompt_tokens,
      completion: data.usage?.completion_tokens,
      total: data.usage?.total_tokens,
    })

    const message = data.choices?.[0]?.message
    const toolCalls = message?.tool_calls ?? []
    if (tools && tools.length > 0) {
      console.info(
        `[ai openrouter] round ${round}: ${toolCalls.length} tool call(s)`,
        toolCalls.map((c) => c.function?.name),
      )
    }

    if (toolCalls.length > 0 && executeTool && round < MAX_TOOL_ROUNDS) {
      body.push({ role: 'assistant', content: message?.content ?? null, tool_calls: toolCalls })
      for (const tc of toolCalls) {
        const name = tc.function?.name ?? ''
        let parsedArgs: Record<string, unknown> = {}
        try {
          parsedArgs = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {}
        } catch {
          // Malformed JSON from the model — run the tool with no args
          // rather than failing the whole turn; the tool's own arg
          // validation will report back a clear error to the model.
        }
        const result = await executeTool(name, parsedArgs)
        body.push({ role: 'tool', tool_call_id: tc.id, content: result })
      }
      continue
    }

    const text = message?.content
    if (!text || typeof text !== 'string' || !text.trim()) {
      throw new AiError('OpenRouter returned an empty response.', { code: 'empty_response' })
    }
    return { text, usage }
  }

  throw new AiError('OpenRouter kept calling tools without answering.', { code: 'empty_response' })
}
