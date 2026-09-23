import { AiError, type ChatMessage, type ProviderResult, type ToolDefinition } from '../types'
import { MAX_OUTPUT_TOKENS } from '../defaults'
import { normalizeUsage, providerHttpError, toNetworkError, MAX_TOOL_ROUNDS, type ProviderArgs } from './shared'

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models'

interface GeminiPart {
  text?: string
  functionCall?: { name?: string; args?: Record<string, unknown> }
  functionResponse?: { name: string; response: { result: string } }
}

interface GeminiResponse {
  candidates?: {
    content?: { parts?: GeminiPart[] }
    finishReason?: string
  }[]
  usageMetadata?: {
    promptTokenCount?: number
    candidatesTokenCount?: number
    totalTokenCount?: number
  }
  promptFeedback?: { blockReason?: string }
}

type GeminiContent = { role: 'user' | 'model'; parts: GeminiPart[] }

/**
 * Gemini has no `system` role turn — `mergeConsecutive` from shared.ts
 * assumes `'user' | 'assistant'` roles, so map straight to Gemini's own
 * `user`/`model` roles here instead of reusing it.
 */
function toGeminiContents(messages: ChatMessage[]): GeminiContent[] {
  const out: GeminiContent[] = []
  for (const m of messages) {
    const role = m.role === 'assistant' ? 'model' : 'user'
    const last = out[out.length - 1]
    if (last && last.role === role && last.parts[0]?.text !== undefined) {
      last.parts[0].text = `${last.parts[0].text}\n\n${m.content}`
    } else {
      out.push({ role, parts: [{ text: m.content }] })
    }
  }
  // Gemini requires at least one content turn.
  if (out.length === 0) {
    out.push({ role: 'user', parts: [{ text: '(The customer has not sent a message yet.)' }] })
  }
  return out
}

/** Gemini's function-declaration schema wants OpenAPI-style uppercase
 *  type names (`STRING`, `OBJECT`, ...), not JSON Schema's lowercase —
 *  our `ToolDefinition.parameters` is authored once, in plain JSON
 *  Schema, and reused for OpenAI/Anthropic as-is; only Gemini needs
 *  this recursive type-casing pass. */
function toGeminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toGeminiSchema)
  if (!schema || typeof schema !== 'object') return schema
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (key === 'type' && typeof value === 'string') {
      out[key] = value.toUpperCase()
    } else {
      out[key] = toGeminiSchema(value)
    }
  }
  return out
}

function toGeminiTools(tools: ToolDefinition[]) {
  return [
    {
      functionDeclarations: tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: toGeminiSchema(t.parameters),
      })),
    },
  ]
}

/**
 * Call Google's Generative Language `generateContent` endpoint with the
 * caller's own Google AI Studio key. Returns the raw assistant text +
 * token usage (handoff parsing happens in `generateReply`). When
 * `tools`/`executeTool` are supplied, runs its own bounded tool-calling
 * loop (see `MAX_TOOL_ROUNDS`): a response whose parts include a
 * `functionCall` is answered by executing it and re-posting the model's
 * own turn back plus a `functionResponse` turn per call, until the
 * model returns plain text only.
 */
export async function generateGemini(args: ProviderArgs): Promise<ProviderResult> {
  const { apiKey, model, systemPrompt, messages, timeoutMs, tools, executeTool } = args
  const url = `${GEMINI_BASE_URL}/${encodeURIComponent(model)}:generateContent`

  const contents: GeminiContent[] = toGeminiContents(messages)

  // `timeoutMs` is a TOTAL budget for the whole exchange, not per
  // request — see the matching comment in providers/openai.ts.
  const deadline = Date.now() + timeoutMs

  const call = async (): Promise<GeminiResponse> => {
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      throw new AiError('The AI provider took too long to respond.', {
        code: 'timeout',
        status: 504,
      })
    }
    let res: Response
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'x-goog-api-key': apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents,
          generationConfig: { maxOutputTokens: MAX_OUTPUT_TOKENS },
          ...(tools && tools.length > 0 ? { tools: toGeminiTools(tools) } : {}),
        }),
        signal: AbortSignal.timeout(remaining),
      })
    } catch (err) {
      throw toNetworkError(err)
    }
    if (!res.ok) throw await providerHttpError('Gemini', res)
    const data = (await res.json().catch(() => null)) as GeminiResponse | null
    if (!data) {
      throw new AiError('Gemini returned an unparsable response.', { code: 'empty_response' })
    }
    return data
  }

  let usage: ReturnType<typeof normalizeUsage> = null
  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const data = await call()

    const blockReason = data.promptFeedback?.blockReason
    if (blockReason) {
      throw new AiError(`Gemini blocked the response: ${blockReason}`, {
        code: 'content_blocked',
        status: 502,
      })
    }

    usage = normalizeUsage({
      prompt: data.usageMetadata?.promptTokenCount,
      completion: data.usageMetadata?.candidatesTokenCount,
      total: data.usageMetadata?.totalTokenCount,
    })

    const parts = data.candidates?.[0]?.content?.parts ?? []
    const calls = parts.filter((p) => p.functionCall)
    if (tools && tools.length > 0) {
      console.info(
        `[ai gemini] round ${round}: ${calls.length} tool call(s)`,
        calls.map((p) => p.functionCall?.name),
      )
    }

    if (calls.length > 0 && executeTool && round < MAX_TOOL_ROUNDS) {
      contents.push({ role: 'model', parts: calls.map((p) => ({ functionCall: p.functionCall })) })
      const responseParts: GeminiPart[] = []
      for (const p of calls) {
        const name = p.functionCall?.name ?? ''
        const result = await executeTool(name, p.functionCall?.args ?? {})
        responseParts.push({ functionResponse: { name, response: { result } } })
      }
      contents.push({ role: 'user', parts: responseParts })
      continue
    }

    const text = parts
      .map((p) => p.text ?? '')
      .join('')
      .trim()
    if (!text) {
      throw new AiError('Gemini returned an empty response.', { code: 'empty_response' })
    }
    return { text, usage }
  }

  throw new AiError('Gemini kept calling tools without answering.', { code: 'empty_response' })
}
