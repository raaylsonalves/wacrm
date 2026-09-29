import { describe, it, expect } from 'vitest'
import {
  ModelListError,
  fetchModelList,
  normalizeAnthropicModels,
  normalizeGeminiModels,
  normalizeOpenAiModels,
  normalizeOpenRouterModels,
} from './models'

describe('normalizeAnthropicModels', () => {
  it('reads id and display name', () => {
    expect(
      normalizeAnthropicModels({
        data: [
          { id: 'claude-sonnet-x', display_name: 'Claude Sonnet X', type: 'model' },
          { id: 'claude-haiku-y' },
          { display_name: 'no id' },
        ],
      }),
    ).toEqual([
      { id: 'claude-sonnet-x', label: 'Claude Sonnet X' },
      { id: 'claude-haiku-y', label: 'claude-haiku-y' },
    ])
  })

  it('never invents a price, window or tool flag', () => {
    const [m] = normalizeAnthropicModels({ data: [{ id: 'a', display_name: 'A' }] })
    expect(m).not.toHaveProperty('inputPerMTok')
    expect(m).not.toHaveProperty('contextWindow')
    expect(m).not.toHaveProperty('supportsTools')
  })
})

describe('normalizeGeminiModels', () => {
  it('keeps only generateContent models and strips the models/ prefix', () => {
    expect(
      normalizeGeminiModels({
        models: [
          {
            name: 'models/gemini-2.5-flash',
            displayName: 'Gemini 2.5 Flash',
            inputTokenLimit: 1048576,
            supportedGenerationMethods: ['generateContent', 'countTokens'],
          },
          {
            name: 'models/text-embedding-004',
            displayName: 'Embedding',
            supportedGenerationMethods: ['embedContent'],
          },
          { name: 'models/aqa', supportedGenerationMethods: ['generateAnswer'] },
        ],
      }),
    ).toEqual([
      { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', contextWindow: 1048576 },
    ])
  })
})

describe('normalizeOpenAiModels', () => {
  it('keeps chat families and drops embeddings, audio, image, moderation…', () => {
    const ids = normalizeOpenAiModels({
      data: [
        { id: 'gpt-5.4-mini' },
        { id: 'gpt-4o' },
        { id: 'o3-mini' },
        { id: 'chatgpt-4o-latest' },
        { id: 'text-embedding-3-small' },
        { id: 'whisper-1' },
        { id: 'tts-1' },
        { id: 'dall-e-3' },
        { id: 'gpt-image-1' },
        { id: 'omni-moderation-latest' },
        { id: 'gpt-4o-realtime-preview' },
        { id: 'gpt-4o-audio-preview' },
        { id: 'gpt-3.5-turbo-instruct' },
        { id: 'davinci-002' },
      ],
    }).map((m) => m.id)
    expect(ids.sort()).toEqual(['chatgpt-4o-latest', 'gpt-4o', 'gpt-5.4-mini', 'o3-mini'].sort())
  })

  it('lists the newest-looking ids first', () => {
    const ids = normalizeOpenAiModels({ data: [{ id: 'gpt-4o' }, { id: 'gpt-5' }] }).map((m) => m.id)
    expect(ids[0]).toBe('gpt-5')
  })
})

describe('normalizeOpenRouterModels', () => {
  it('converts per-token prices to per-million and reads tool support', () => {
    const [m] = normalizeOpenRouterModels({
      data: [
        {
          id: 'vendor/model',
          name: 'Vendor Model',
          context_length: 128000,
          pricing: { prompt: '0.0000005', completion: '0.0000015' },
          supported_parameters: ['temperature', 'tools'],
        },
      ],
    })
    expect(m.id).toBe('vendor/model')
    expect(m.contextWindow).toBe(128000)
    expect(m.inputPerMTok).toBeCloseTo(0.5)
    expect(m.outputPerMTok).toBeCloseTo(1.5)
    expect(m.supportsTools).toBe(true)
  })

  it('says a model lacks tools only when the provider lists parameters without it', () => {
    const [noTools, unknown] = normalizeOpenRouterModels({
      data: [
        { id: 'a', supported_parameters: ['temperature'] },
        { id: 'b' }, // provider said nothing → unknown, not "unsupported"
      ],
    })
    expect(noTools.supportsTools).toBe(false)
    expect(unknown.supportsTools).toBeUndefined()
  })

  it('leaves a missing or garbage price undefined rather than 0', () => {
    const [m] = normalizeOpenRouterModels({
      data: [{ id: 'a', pricing: { prompt: 'n/a' } }],
    })
    expect(m.inputPerMTok).toBeUndefined()
    expect(m.outputPerMTok).toBeUndefined()
  })
})

describe('fetchModelList', () => {
  const ok = (body: unknown) =>
    (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch
  const status = (code: number) =>
    (async () => new Response('secret-body-sk-123', { status: code })) as unknown as typeof fetch

  it('lists and normalizes', async () => {
    const out = await fetchModelList({
      provider: 'anthropic',
      apiKey: 'k',
      fetchImpl: ok({ data: [{ id: 'claude-x', display_name: 'X' }] }),
    })
    expect(out).toEqual([{ id: 'claude-x', label: 'X' }])
  })

  it('sends the key in the provider-specific header, never in the URL', async () => {
    const seen: { url: string; headers: Record<string, string> }[] = []
    const spy = (async (url: string, init: RequestInit) => {
      seen.push({ url, headers: init.headers as Record<string, string> })
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch
    for (const provider of ['anthropic', 'gemini', 'openai'] as const) {
      await fetchModelList({ provider, apiKey: 'SECRET', fetchImpl: spy })
    }
    for (const call of seen) {
      expect(call.url).not.toContain('SECRET')
      expect(JSON.stringify(call.headers)).toContain('SECRET')
    }
  })

  it('lists OpenRouter without sending the key at all (the catalogue is public)', async () => {
    let seenHeaders: unknown
    const spy = (async (_url: string, init: RequestInit) => {
      seenHeaders = init.headers
      return new Response(JSON.stringify({ data: [{ id: 'a/b' }] }), { status: 200 })
    }) as unknown as typeof fetch
    const out = await fetchModelList({ provider: 'openrouter', apiKey: 'SECRET', fetchImpl: spy })
    expect(out.map((m) => m.id)).toEqual(['a/b'])
    expect(JSON.stringify(seenHeaders)).not.toContain('SECRET')
  })

  it('maps provider statuses to short codes and never echoes the body', async () => {
    const codeFor = async (s: number) => {
      try {
        await fetchModelList({ provider: 'openai', apiKey: 'k', fetchImpl: status(s) })
      } catch (e) {
        expect(e).toBeInstanceOf(ModelListError)
        expect((e as Error).message).not.toContain('secret-body')
        return (e as ModelListError).code
      }
    }
    expect(await codeFor(401)).toBe('invalid_key')
    expect(await codeFor(403)).toBe('invalid_key')
    expect(await codeFor(429)).toBe('rate_limited')
    expect(await codeFor(500)).toBe('unreachable')
  })

  it('reports a network failure as unreachable', async () => {
    const boom = (async () => {
      throw new Error('ECONNRESET with sk-live-key in it')
    }) as unknown as typeof fetch
    await expect(
      fetchModelList({ provider: 'gemini', apiKey: 'k', fetchImpl: boom }),
    ).rejects.toMatchObject({ code: 'unreachable', message: 'Could not reach the provider' })
  })
})

describe('SUGGESTED_MODELS', () => {
  it('covers every provider with ids only — never a price, window or tool flag', async () => {
    const { SUGGESTED_MODELS } = await import('./models')
    for (const provider of ['openai', 'anthropic', 'gemini', 'openrouter'] as const) {
      const list = SUGGESTED_MODELS[provider]
      expect(list.length).toBeGreaterThan(0)
      expect(new Set(list.map((m) => m.id)).size).toBe(list.length)
      for (const m of list) {
        expect(Object.keys(m).sort()).toEqual(['id', 'label'])
      }
    }
  })

  it('includes each provider default so a fresh agent shows its own model', async () => {
    const { SUGGESTED_MODELS } = await import('./models')
    const { AI_PROVIDER_DEFAULT_MODEL } = await import('./defaults')
    for (const provider of ['openai', 'anthropic', 'gemini', 'openrouter'] as const) {
      expect(SUGGESTED_MODELS[provider].map((m) => m.id)).toContain(
        AI_PROVIDER_DEFAULT_MODEL[provider],
      )
    }
  })
})
