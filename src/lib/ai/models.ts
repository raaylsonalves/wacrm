// ============================================================
// Model lists from the provider itself (specs/ai-agents-management.md §1).
//
// The model used to be a free-text box: users had to know that
// `claude-sonnet-4-5` or `gemini-2.5-flash` are valid ids for their key,
// and a typo surfaced only when a customer message failed. This asks the
// provider what the key can actually use.
//
// Two rules that matter more than the code:
//   - NEVER invent data. A price or context window the provider didn't
//     supply is simply absent — there is no hard-coded price table (it
//     would go stale silently), and `supportsTools` is only set when the
//     provider states it. A wrong "this model can't use tools" warning is
//     worse than none.
//   - The picker can never block a save. A failed list falls back to
//     "type the id" in the UI; this module reports WHY it failed with a
//     short code, and never echoes the key.
//
// The normalizers are pure (fixture-tested per provider); only
// `fetchModelList` touches the network.
// ============================================================

import type { AiProvider } from './types'

export interface ModelOption {
  /** What gets stored in `ai_configs.model`. */
  id: string
  label: string
  contextWindow?: number
  /** USD per million tokens — only when the provider supplies it. */
  inputPerMTok?: number
  outputPerMTok?: number
  /** Only set when the provider states it (OpenRouter does). */
  supportsTools?: boolean
}

/**
 * Ids shown while there is no key to ask the provider with. OpenAI,
 * Anthropic and Gemini only list models for a key, so without one the
 * picker offers these as SUGGESTIONS (ids only — no price, window or tool
 * flag, per the rule above) and says so; the real list replaces them the
 * moment a key is present. Not exhaustive and it can age, which is why it
 * is never used as the truth: the input stays free text.
 */
export const SUGGESTED_MODELS: Record<AiProvider, ModelOption[]> = {
  openai: ['gpt-5.4-mini', 'gpt-4o-mini', 'gpt-4o'].map(toOption),
  anthropic: [
    'claude-haiku-4-5-20251001',
    'claude-sonnet-5-5',
    'claude-opus-5-5',
    'claude-fable-5-1',
  ].map(toOption),
  gemini: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-3.1-flash-lite'].map(toOption),
  // OpenRouter lists without a key; this is only a last resort.
  openrouter: ['openrouter/free'].map(toOption),
}

function toOption(id: string): ModelOption {
  return { id, label: id }
}

export type ModelListErrorCode = 'invalid_key' | 'rate_limited' | 'unreachable'

export class ModelListError extends Error {
  constructor(
    public code: ModelListErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'ModelListError'
  }
}

type Json = Record<string, unknown>
const asArray = (v: unknown): Json[] =>
  Array.isArray(v) ? (v.filter((x) => x && typeof x === 'object') as Json[]) : []
const asString = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v : undefined
const asNumber = (v: unknown): number | undefined => {
  const n = typeof v === 'string' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined
}

// ------------------------------------------------------------
// Normalizers
// ------------------------------------------------------------

export function normalizeAnthropicModels(body: unknown): ModelOption[] {
  return asArray((body as Json | null)?.data).flatMap((m) => {
    const id = asString(m.id)
    if (!id) return []
    return [{ id, label: asString(m.display_name) ?? id }]
  })
}

export function normalizeGeminiModels(body: unknown): ModelOption[] {
  return asArray((body as Json | null)?.models).flatMap((m) => {
    const name = asString(m.name)
    if (!name) return []
    // Embedding / AQA models list no generateContent — not usable as a
    // chat model here.
    const methods = Array.isArray(m.supportedGenerationMethods)
      ? (m.supportedGenerationMethods as unknown[])
      : []
    if (!methods.includes('generateContent')) return []
    const id = name.replace(/^models\//, '')
    return [
      {
        id,
        label: asString(m.displayName) ?? id,
        contextWindow: asNumber(m.inputTokenLimit),
      },
    ]
  })
}

/** OpenAI's `/v1/models` returns EVERYTHING (embeddings, whisper, tts,
 *  moderation, image…). This keeps chat families and drops the rest — a
 *  heuristic, hence the UI's always-available "type the id" escape. */
const OPENAI_CHAT = /^(gpt-|chatgpt-|o\d)/
const OPENAI_NOT_CHAT =
  /(embedding|whisper|tts|dall-e|image|moderation|audio|realtime|transcribe|search|instruct|davinci|babbage|computer-use|codex)/

export function normalizeOpenAiModels(body: unknown): ModelOption[] {
  return asArray((body as Json | null)?.data)
    .flatMap((m) => {
      const id = asString(m.id)
      if (!id || !OPENAI_CHAT.test(id) || OPENAI_NOT_CHAT.test(id)) return []
      return [{ id, label: id }]
    })
    .sort((a, b) => b.id.localeCompare(a.id))
}

export function normalizeOpenRouterModels(body: unknown): ModelOption[] {
  return asArray((body as Json | null)?.data).flatMap((m) => {
    const id = asString(m.id)
    if (!id) return []
    const pricing = (m.pricing ?? {}) as Json
    const perTokenIn = asNumber(pricing.prompt)
    const perTokenOut = asNumber(pricing.completion)
    const params = Array.isArray(m.supported_parameters)
      ? (m.supported_parameters as unknown[])
      : null
    return [
      {
        id,
        label: asString(m.name) ?? id,
        contextWindow: asNumber(m.context_length),
        // OpenRouter prices are per single token, as strings.
        inputPerMTok: perTokenIn !== undefined ? perTokenIn * 1_000_000 : undefined,
        outputPerMTok: perTokenOut !== undefined ? perTokenOut * 1_000_000 : undefined,
        // Only OpenRouter states tool support per model; absent list =
        // unknown, NOT "unsupported".
        supportsTools: params ? params.includes('tools') : undefined,
      },
    ]
  })
}

export function normalizeModels(provider: AiProvider, body: unknown): ModelOption[] {
  switch (provider) {
    case 'anthropic':
      return normalizeAnthropicModels(body)
    case 'gemini':
      return normalizeGeminiModels(body)
    case 'openai':
      return normalizeOpenAiModels(body)
    case 'openrouter':
      return normalizeOpenRouterModels(body)
  }
}

// ------------------------------------------------------------
// Fetching
// ------------------------------------------------------------

const TIMEOUT_MS = 8_000

function requestFor(provider: AiProvider, apiKey: string): { url: string; headers: Record<string, string> } {
  switch (provider) {
    case 'anthropic':
      return {
        url: 'https://api.anthropic.com/v1/models?limit=100',
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      }
    case 'gemini':
      return {
        url: 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=200',
        headers: { 'x-goog-api-key': apiKey },
      }
    case 'openai':
      return {
        url: 'https://api.openai.com/v1/models',
        headers: { Authorization: `Bearer ${apiKey}` },
      }
    case 'openrouter':
      // The catalogue is public, so it is listed WITHOUT the key: a
      // wrong key must not hide the list (it is validated on save).
      return { url: 'https://openrouter.ai/api/v1/models', headers: {} }
  }
}

/**
 * List the models a key can use. Throws `ModelListError` with a short
 * code; the message is deliberately generic — it never carries the
 * provider's raw body or the key.
 */
export async function fetchModelList(args: {
  provider: AiProvider
  apiKey: string
  fetchImpl?: typeof fetch
}): Promise<ModelOption[]> {
  const { url, headers } = requestFor(args.provider, args.apiKey)
  const doFetch = args.fetchImpl ?? fetch

  let res: Response
  try {
    res = await doFetch(url, {
      headers,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: 'no-store',
    })
  } catch {
    throw new ModelListError('unreachable', 'Could not reach the provider')
  }

  if (res.status === 401 || res.status === 403) {
    throw new ModelListError('invalid_key', 'The provider rejected this key')
  }
  if (res.status === 429) {
    throw new ModelListError('rate_limited', 'The provider is rate limiting this key')
  }
  if (!res.ok) {
    throw new ModelListError('unreachable', `The provider returned ${res.status}`)
  }

  let body: unknown
  try {
    body = await res.json()
  } catch {
    throw new ModelListError('unreachable', 'The provider returned an unreadable list')
  }
  return normalizeModels(args.provider, body)
}
