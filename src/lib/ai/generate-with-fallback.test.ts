import { describe, it, expect, vi } from 'vitest'
import { generateReplyWithFallback, AllProvidersFailedError } from './generate-with-fallback'
import { AiError, type AiConfig } from './types'

function config(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    provider: 'gemini',
    model: 'gemini-2.5-flash',
    apiKey: 'key-primary',
    systemPrompt: null,
    isActive: true,
    autoReplyEnabled: true,
    autoReplyMaxPerConversation: 3,
    handoffAgentId: null,
    embeddingsApiKey: null,
    fallbacks: [],
    agendaEnabled: false,
    ...overrides,
  }
}

// No-op delay so tests don't actually wait through the real backoff.
const noDelay = async () => {}

describe('generateReplyWithFallback', () => {
  it('returns the primary tier result untouched when it succeeds', async () => {
    const generate = vi.fn().mockResolvedValue({ text: 'hi', handoff: false, usage: null })
    const result = await generateReplyWithFallback(
      { config: config(), systemPrompt: 'sys', messages: [] },
      { generate, delay: noDelay },
    )
    expect(result).toEqual({
      text: 'hi',
      handoff: false,
      usage: null,
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      attempts: [],
    })
    expect(generate).toHaveBeenCalledTimes(1)
  })

  it('retries a transient error on the same tier before succeeding', async () => {
    const generate = vi
      .fn()
      .mockRejectedValueOnce(new AiError('down', { code: 'provider_error' }))
      .mockResolvedValueOnce({ text: 'ok', handoff: false, usage: null })
    const result = await generateReplyWithFallback(
      { config: config(), systemPrompt: 'sys', messages: [] },
      { generate, delay: noDelay },
    )
    expect(generate).toHaveBeenCalledTimes(2)
    expect(result.provider).toBe('gemini')
    expect(result.attempts).toEqual([])
  })

  it('advances to a fallback tier after the primary exhausts its retries', async () => {
    // Primary fails twice (initial attempt + its 1 retry), then the fallback tier succeeds.
    const seq = vi
      .fn()
      .mockRejectedValueOnce(new AiError('down', { code: 'provider_error' }))
      .mockRejectedValueOnce(new AiError('down', { code: 'provider_error' }))
      .mockResolvedValueOnce({ text: 'from fallback', handoff: false, usage: null })

    const result = await generateReplyWithFallback(
      {
        config: config({
          fallbacks: [{ provider: 'anthropic', model: 'claude-haiku', apiKey: 'key-fallback' }],
        }),
        systemPrompt: 'sys',
        messages: [],
      },
      { generate: seq, delay: noDelay },
    )
    expect(result.provider).toBe('anthropic')
    expect(result.model).toBe('claude-haiku')
    expect(result.text).toBe('from fallback')
    expect(result.attempts).toHaveLength(1)
    expect(result.attempts[0].provider).toBe('gemini')
    expect(seq).toHaveBeenCalledTimes(3) // 2 primary attempts + 1 fallback attempt
  })

  it('skips straight to the next tier on rate_limited without retrying', async () => {
    const generate = vi
      .fn()
      .mockRejectedValueOnce(new AiError('quota', { code: 'rate_limited' }))
      .mockResolvedValueOnce({ text: 'from fallback', handoff: false, usage: null })
    const result = await generateReplyWithFallback(
      {
        config: config({
          fallbacks: [{ provider: 'anthropic', model: 'claude-haiku', apiKey: 'key-fallback' }],
        }),
        systemPrompt: 'sys',
        messages: [],
      },
      { generate, delay: noDelay },
    )
    // Exactly one call for the primary (no retry on rate_limited) + one for the fallback.
    expect(generate).toHaveBeenCalledTimes(2)
    expect(result.provider).toBe('anthropic')
  })

  it('skips straight to the next tier on invalid_key without retrying', async () => {
    const generate = vi
      .fn()
      .mockRejectedValueOnce(new AiError('bad key', { code: 'invalid_key' }))
      .mockResolvedValueOnce({ text: 'from fallback', handoff: false, usage: null })
    const result = await generateReplyWithFallback(
      {
        config: config({
          fallbacks: [{ provider: 'anthropic', model: 'claude-haiku', apiKey: 'key-fallback' }],
        }),
        systemPrompt: 'sys',
        messages: [],
      },
      { generate, delay: noDelay },
    )
    expect(generate).toHaveBeenCalledTimes(2)
    expect(result.provider).toBe('anthropic')
  })

  it('throws AllProvidersFailedError with every attempt when all tiers fail', async () => {
    const generate = vi
      .fn()
      .mockRejectedValue(new AiError('down', { code: 'provider_error' }))
    const promise = generateReplyWithFallback(
      {
        config: config({
          fallbacks: [{ provider: 'anthropic', model: 'claude-haiku', apiKey: 'key-fallback' }],
        }),
        systemPrompt: 'sys',
        messages: [],
      },
      { generate, delay: noDelay },
    )
    await expect(promise).rejects.toBeInstanceOf(AllProvidersFailedError)
    try {
      await promise
    } catch (err) {
      const failure = err as InstanceType<typeof AllProvidersFailedError>
      expect(failure.attempts).toHaveLength(2)
      expect(failure.attempts.map((a) => a.provider)).toEqual(['gemini', 'anthropic'])
    }
  })

  it('never retries or falls back on a non-transient error with no fallback configured', async () => {
    const generate = vi.fn().mockRejectedValue(new AiError('bad key', { code: 'invalid_key' }))
    await expect(
      generateReplyWithFallback(
        { config: config(), systemPrompt: 'sys', messages: [] },
        { generate, delay: noDelay },
      ),
    ).rejects.toBeInstanceOf(AllProvidersFailedError)
    expect(generate).toHaveBeenCalledTimes(1)
  })
})
