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

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions'

interface OpenAiToolCall {
  id: string
  function?: { name?: string; arguments?: string }
}

interface OpenAiMessage {
  content?: string
  tool_calls?: OpenAiToolCall[]
}

interface OpenAiResponse {
  choices?: { message?: OpenAiMessage }[]
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
  }
}

function toOpenAiTools(tools: ToolDefinition[]) {
  return tools.map((t) => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }))
}

/**
 * Call OpenAI's Chat Completions endpoint with the caller's own key.
 * Returns the raw assistant text + token usage (handoff parsing happens
 * in `generateReply`). When `tools`/`executeTool` are supplied, runs its
 * own bounded tool-calling loop (see `MAX_TOOL_ROUNDS`): a response
 * carrying `tool_calls` is answered by executing each one and re-posting
 * the conversation with the assistant's tool-call turn plus one `role:
 * 'tool'` message per result, until the model returns plain text.
 */
export async function generateOpenAi(args: ProviderArgs): Promise<ProviderResult> {
  const { apiKey, model, systemPrompt, messages, timeoutMs, tools, executeTool } = args

  const body: Record<string, unknown>[] = [
    { role: 'system', content: systemPrompt },
    ...mergeConsecutive(messages).map((m) => ({ role: m.role, content: m.content })),
  ]

  // `timeoutMs` is a TOTAL budget for the whole exchange, not per
  // request — a tool-calling round trip can mean several sequential
  // fetches (plus tool execution time in between), and each one draws
  // down the same deadline instead of getting its own fresh timeoutMs.
  // Without this, MAX_TOOL_ROUNDS worth of full-length requests could
  // add up to several times timeoutMs and blow through the webhook
  // route's 60s maxDuration with no reply ever sent.
  const deadline = Date.now() + timeoutMs

  const call = async (): Promise<OpenAiResponse> => {
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      throw new AiError('The AI provider took too long to respond.', {
        code: 'timeout',
        status: 504,
      })
    }
    let res: Response
    try {
      res = await fetch(OPENAI_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages: body,
          max_completion_tokens: MAX_OUTPUT_TOKENS,
          ...(tools && tools.length > 0 ? { tools: toOpenAiTools(tools) } : {}),
        }),
        signal: AbortSignal.timeout(remaining),
      })
    } catch (err) {
      throw toNetworkError(err)
    }
    if (!res.ok) throw await providerHttpError('OpenAI', res)
    const data = (await res.json().catch(() => null)) as OpenAiResponse | null
    if (!data) {
      throw new AiError('OpenAI returned an unparsable response.', { code: 'empty_response' })
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
        `[ai openai] round ${round}: ${toolCalls.length} tool call(s)`,
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
      throw new AiError('OpenAI returned an empty response.', { code: 'empty_response' })
    }
    return { text, usage }
  }

  throw new AiError('OpenAI kept calling tools without answering.', { code: 'empty_response' })
}
