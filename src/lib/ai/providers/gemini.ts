import { AiError, type ChatMessage, type ProviderResult } from '../types'
import { MAX_OUTPUT_TOKENS } from '../defaults'
import {
  normalizeUsage,
  providerHttpError,
  toNetworkError,
  type ProviderArgs,
} from './shared'

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models'

interface GeminiResponse {
  candidates?: {
    content?: { parts?: { text?: string }[] }
    finishReason?: string
  }[]
  usageMetadata?: {
    promptTokenCount?: number
    candidatesTokenCount?: number
    totalTokenCount?: number
  }
  promptFeedback?: { blockReason?: string }
}

/**
 * Gemini has no `system` role turn — `mergeConsecutive` from shared.ts
 * assumes `'user' | 'assistant'` roles, so map straight to Gemini's own
 * `user`/`model` roles here instead of reusing it.
 */
function toGeminiContents(messages: ChatMessage[]): { role: 'user' | 'model'; parts: { text: string }[] }[] {
  const out: { role: 'user' | 'model'; parts: { text: string }[] }[] = []
  for (const m of messages) {
    const role = m.role === 'assistant' ? 'model' : 'user'
    const last = out[out.length - 1]
    if (last && last.role === role) {
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

/**
 * Call Google's Generative Language `generateContent` endpoint with the
 * caller's own Google AI Studio key. Returns the raw assistant text +
 * token usage (handoff parsing happens in `generateReply`).
 */
export async function generateGemini(args: ProviderArgs): Promise<ProviderResult> {
  const { apiKey, model, systemPrompt, messages, timeoutMs } = args
  const url = `${GEMINI_BASE_URL}/${encodeURIComponent(model)}:generateContent`

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
        contents: toGeminiContents(messages),
        generationConfig: { maxOutputTokens: MAX_OUTPUT_TOKENS },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    throw toNetworkError(err)
  }

  if (!res.ok) {
    throw await providerHttpError('Gemini', res)
  }

  const data = (await res.json().catch(() => null)) as GeminiResponse | null

  const blockReason = data?.promptFeedback?.blockReason
  if (blockReason) {
    throw new AiError(`Gemini blocked the response: ${blockReason}`, {
      code: 'content_blocked',
      status: 502,
    })
  }

  const text = data?.candidates?.[0]?.content?.parts
    ?.map((p) => p.text ?? '')
    .join('')
    .trim()
  if (!text) {
    throw new AiError('Gemini returned an empty response.', {
      code: 'empty_response',
    })
  }
  const usage = normalizeUsage({
    prompt: data?.usageMetadata?.promptTokenCount,
    completion: data?.usageMetadata?.candidatesTokenCount,
    total: data?.usageMetadata?.totalTokenCount,
  })
  return { text, usage }
}
