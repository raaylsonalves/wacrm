import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { generateReply, parseGeneration } from './generate'
import { AiError, type AiConfig } from './types'

function config(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    provider: 'openai',
    model: 'gpt-test',
    apiKey: 'sk-test',
    systemPrompt: null,
    isActive: true,
    autoReplyEnabled: false,
    autoReplyMaxPerConversation: 3,
    handoffAgentId: null,
    embeddingsApiKey: null,
    fallbacks: [],
    agendaEnabled: false,
    ...overrides,
  }
}

function okResponse(json: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => json,
  } as unknown as Response
}

function errResponse(status: number, json: unknown): Response {
  return {
    ok: false,
    status,
    json: async () => json,
  } as unknown as Response
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
})
afterEach(() => vi.unstubAllGlobals())

describe('parseGeneration', () => {
  it('returns text with no handoff', () => {
    expect(parseGeneration('Hello there')).toEqual({
      text: 'Hello there',
      segments: ['Hello there'],
      handoff: false,
      usage: null,
    })
  })

  it('detects + strips the handoff sentinel', () => {
    expect(parseGeneration('[[HANDOFF]]')).toEqual({
      text: '',
      segments: [],
      handoff: true,
      usage: null,
    })
    expect(parseGeneration('Let me get a human [[HANDOFF]]')).toEqual({
      text: 'Let me get a human',
      segments: ['Let me get a human'],
      handoff: true,
      usage: null,
    })
  })

  it('passes usage straight through', () => {
    const usage = { promptTokens: 10, completionTokens: 5, totalTokens: 15 }
    expect(parseGeneration('Hi', usage)).toEqual({
      text: 'Hi',
      segments: ['Hi'],
      handoff: false,
      usage,
    })
  })

  it('splits on the multi-message delimiter', () => {
    expect(parseGeneration('First part [[NEXT]] Second part')).toEqual({
      text: 'First part\n\nSecond part',
      segments: ['First part', 'Second part'],
      handoff: false,
      usage: null,
    })
  })

  it('drops empty segments from stray/leading/trailing delimiters', () => {
    expect(parseGeneration('[[NEXT]] Only one [[NEXT]]')).toEqual({
      text: 'Only one',
      segments: ['Only one'],
      handoff: false,
      usage: null,
    })
  })

  it('never leaves the literal delimiter in `text` — regression for the draft-mode leak', () => {
    // A custom business-context prompt (appended in every mode, not
    // just auto-reply) can teach the model the delimiter even for a
    // draft call that never reads `segments` — `text` must be safe on
    // its own regardless of who's asking.
    const result = parseGeneration('Parte um [[NEXT]] Parte dois [[NEXT]] Parte três')
    expect(result.text).not.toContain('[[NEXT]]')
    expect(result.text).toBe('Parte um\n\nParte dois\n\nParte três')
  })

  it('caps segments, merging overflow into the last one', () => {
    const raw = ['one', 'two', 'three', 'four', 'five'].join(' [[NEXT]] ')
    const result = parseGeneration(raw)
    expect(result.segments).toHaveLength(4)
    expect(result.segments[0]).toBe('one')
    expect(result.segments[1]).toBe('two')
    expect(result.segments[2]).toBe('three')
    expect(result.segments[3]).toBe('four\n\nfive')
  })
})

describe('generateReply — OpenAI', () => {
  it('calls the chat completions endpoint and returns the reply', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({
        choices: [{ message: { content: 'Sure — happy to help!' } }],
        usage: { prompt_tokens: 42, completion_tokens: 8, total_tokens: 50 },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const res = await generateReply({
      config: config({ provider: 'openai' }),
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'Hi' }],
    })

    expect(res).toEqual({
      text: 'Sure — happy to help!',
      segments: ['Sure — happy to help!'],
      handoff: false,
      usage: { promptTokens: 42, completionTokens: 8, totalTokens: 50 },
    })
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toContain('api.openai.com')
    expect(opts.headers.Authorization).toBe('Bearer sk-test')
  })

  it('maps a 401 to an invalid_key AiError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        errResponse(401, { error: { message: 'Incorrect API key' } }),
      ),
    )

    await expect(
      generateReply({
        config: config(),
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    ).rejects.toMatchObject({ code: 'invalid_key', status: 401 })
  })

  it('throws on an empty completion', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(okResponse({ choices: [{ message: { content: '' } }] })),
    )
    await expect(
      generateReply({
        config: config(),
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    ).rejects.toBeInstanceOf(AiError)
  })

  it('runs a tool call, feeds the result back, and returns the final text', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        okResponse({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  { id: 'call_1', function: { name: 'offer_slots', arguments: '{"days_ahead":7}' } },
                ],
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        okResponse({ choices: [{ message: { content: 'Enviei as opções!' } }] }),
      )
    vi.stubGlobal('fetch', fetchMock)
    const executeTool = vi.fn().mockResolvedValue('{"sent":true,"count":3}')

    const res = await generateReply({
      config: config({ provider: 'openai' }),
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'quero marcar' }],
      tools: [{ name: 'offer_slots', description: 'x', parameters: { type: 'object', properties: {} } }],
      executeTool,
    })

    expect(res.text).toBe('Enviei as opções!')
    expect(executeTool).toHaveBeenCalledWith('offer_slots', { days_ahead: 7 })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const secondBody = JSON.parse(fetchMock.mock.calls[1][1].body)
    expect(secondBody.messages).toContainEqual(
      expect.objectContaining({ role: 'tool', tool_call_id: 'call_1', content: '{"sent":true,"count":3}' }),
    )
  })

  it('treats timeoutMs as a total budget across tool rounds, not per request', async () => {
    // Round 1 returns a tool call; by the time round 2 would fire, the
    // deadline (Date.now() + timeoutMs, computed once up front) must
    // already be exhausted rather than resetting to a fresh timeoutMs —
    // otherwise MAX_TOOL_ROUNDS worth of full-length requests could add
    // up to several times timeoutMs (specs/ai-agenda-tool-calling.md's
    // reported regression: the webhook's 60s maxDuration got hit with
    // no reply ever sent).
    const fetchMock = vi.fn().mockResolvedValueOnce(
      okResponse({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [{ id: 'call_1', function: { name: 'offer_slots', arguments: '{}' } }],
            },
          },
        ],
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const executeTool = vi.fn().mockResolvedValue('{}')

    const realNow = Date.now
    let calls = 0
    vi.spyOn(Date, 'now').mockImplementation(() => {
      calls++
      // Call 1 establishes the deadline; call 2 is round 0's own
      // `remaining` check (must still pass). Jump time far past
      // timeoutMs starting at call 3 — round 1's `remaining` check.
      return calls <= 2 ? realNow() : realNow() + 999_999
    })

    await expect(
      generateReply({
        config: config({ provider: 'openai' }),
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: 'quero marcar' }],
        tools: [{ name: 'offer_slots', description: 'x', parameters: { type: 'object', properties: {} } }],
        executeTool,
      }),
    ).rejects.toMatchObject({ code: 'timeout' })

    // Exactly one HTTP request was made — the second round was refused
    // locally instead of firing another full-length request.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    vi.restoreAllMocks()
  })

  it('never sends a tools field when no tools are configured', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({ choices: [{ message: { content: 'Hi' } }] }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await generateReply({
      config: config({ provider: 'openai' }),
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'Hi' }],
    })

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body).not.toHaveProperty('tools')
  })
})

describe('generateReply — Anthropic', () => {
  it('calls the messages endpoint with the version header and parses text blocks', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({
        content: [{ type: 'text', text: 'Hi there!' }],
        usage: { input_tokens: 30, output_tokens: 6 },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const res = await generateReply({
      config: config({ provider: 'anthropic', apiKey: 'sk-ant-x' }),
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'Hello' }],
    })

    // Anthropic reports input/output only — total is summed by normalizeUsage.
    expect(res).toEqual({
      text: 'Hi there!',
      segments: ['Hi there!'],
      handoff: false,
      usage: { promptTokens: 30, completionTokens: 6, totalTokens: 36 },
    })
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toContain('api.anthropic.com')
    expect(opts.headers['x-api-key']).toBe('sk-ant-x')
    expect(opts.headers['anthropic-version']).toBeTruthy()
  })

  it('detects handoff in the model output', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okResponse({ content: [{ type: 'text', text: '[[HANDOFF]]' }] }),
      ),
    )
    const res = await generateReply({
      config: config({ provider: 'anthropic' }),
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'I want to speak to a person' }],
    })
    expect(res.handoff).toBe(true)
    expect(res.text).toBe('')
  })

  it('drops a leading assistant turn so the payload starts on the customer', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(okResponse({ content: [{ type: 'text', text: 'ok' }] }))
    vi.stubGlobal('fetch', fetchMock)

    await generateReply({
      config: config({ provider: 'anthropic' }),
      systemPrompt: 'sys',
      messages: [
        { role: 'assistant', content: 'Welcome!' },
        { role: 'user', content: 'Hi' },
      ],
    })

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.messages[0].role).toBe('user')
    expect(body.messages).toHaveLength(1)
  })

  it('runs a tool_use round trip and returns the final text', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        okResponse({
          content: [{ type: 'tool_use', id: 'toolu_1', name: 'book_appointment', input: { slot_id: 'slot:x' } }],
        }),
      )
      .mockResolvedValueOnce(okResponse({ content: [{ type: 'text', text: 'Marcado!' }] }))
    vi.stubGlobal('fetch', fetchMock)
    const executeTool = vi.fn().mockResolvedValue('{"booked":true}')

    const res = await generateReply({
      config: config({ provider: 'anthropic' }),
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'pode marcar' }],
      tools: [{ name: 'book_appointment', description: 'x', parameters: { type: 'object', properties: {} } }],
      executeTool,
    })

    expect(res.text).toBe('Marcado!')
    expect(executeTool).toHaveBeenCalledWith('book_appointment', { slot_id: 'slot:x' })
    const secondBody = JSON.parse(fetchMock.mock.calls[1][1].body)
    expect(secondBody.messages).toContainEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '{"booked":true}' }],
    })
  })
})

describe('generateReply — Gemini', () => {
  it('calls the generateContent endpoint and parses candidate text', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({
        candidates: [{ content: { parts: [{ text: 'Hi from Gemini!' }] } }],
        usageMetadata: {
          promptTokenCount: 20,
          candidatesTokenCount: 4,
          totalTokenCount: 24,
        },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const res = await generateReply({
      config: config({ provider: 'gemini', model: 'gemini-2.5-flash', apiKey: 'g-key' }),
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'Hi' }],
    })

    expect(res).toEqual({
      text: 'Hi from Gemini!',
      segments: ['Hi from Gemini!'],
      handoff: false,
      usage: { promptTokens: 20, completionTokens: 4, totalTokens: 24 },
    })
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toContain('generativelanguage.googleapis.com')
    expect(url).toContain('gemini-2.5-flash')
    expect(opts.headers['x-goog-api-key']).toBe('g-key')
  })

  it('maps a blocked prompt to a content_blocked AiError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(okResponse({ promptFeedback: { blockReason: 'SAFETY' } })),
    )
    await expect(
      generateReply({
        config: config({ provider: 'gemini' }),
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    ).rejects.toMatchObject({ code: 'content_blocked' })
  })

  it('maps a 401 to an invalid_key AiError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(errResponse(401, { error: { message: 'API key not valid' } })),
    )
    await expect(
      generateReply({
        config: config({ provider: 'gemini' }),
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    ).rejects.toMatchObject({ code: 'invalid_key', status: 401 })
  })

  it('runs a functionCall round trip and returns the final text', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        okResponse({
          candidates: [
            { content: { parts: [{ functionCall: { name: 'offer_slots', args: { days_ahead: 3 } } }] } },
          ],
        }),
      )
      .mockResolvedValueOnce(
        okResponse({ candidates: [{ content: { parts: [{ text: 'Aqui estão as opções!' }] } }] }),
      )
    vi.stubGlobal('fetch', fetchMock)
    const executeTool = vi.fn().mockResolvedValue('{"sent":true}')

    const res = await generateReply({
      config: config({ provider: 'gemini' }),
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'quero marcar' }],
      tools: [{ name: 'offer_slots', description: 'x', parameters: { type: 'object', properties: {} } }],
      executeTool,
    })

    expect(res.text).toBe('Aqui estão as opções!')
    expect(executeTool).toHaveBeenCalledWith('offer_slots', { days_ahead: 3 })
    const secondBody = JSON.parse(fetchMock.mock.calls[1][1].body)
    expect(secondBody.contents).toContainEqual({
      role: 'user',
      parts: [{ functionResponse: { name: 'offer_slots', response: { result: '{"sent":true}' } } }],
    })
  })

  it('echoes thoughtSignature back on the model turn — dropping it 400s the follow-up request', async () => {
    // Gemini's "thinking" models require this to come back verbatim on
    // the model's own turn when continuing a tool-calling exchange;
    // omitting it is exactly what caused a real 400 in production
    // ("Function call is missing a thought_signature") and, combined
    // with the fallback chain's retry, duplicate WhatsApp sends.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        okResponse({
          candidates: [
            {
              content: {
                parts: [
                  {
                    functionCall: { name: 'book_appointment', args: { slot_id: 'slot:x' } },
                    thoughtSignature: 'opaque-signature-abc',
                  },
                ],
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(okResponse({ candidates: [{ content: { parts: [{ text: 'Marcado!' }] } }] }))
    vi.stubGlobal('fetch', fetchMock)
    const executeTool = vi.fn().mockResolvedValue('{"booked":true}')

    await generateReply({
      config: config({ provider: 'gemini' }),
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'pode marcar' }],
      tools: [{ name: 'book_appointment', description: 'x', parameters: { type: 'object', properties: {} } }],
      executeTool,
    })

    const secondBody = JSON.parse(fetchMock.mock.calls[1][1].body)
    expect(secondBody.contents).toContainEqual({
      role: 'model',
      parts: [
        {
          functionCall: { name: 'book_appointment', args: { slot_id: 'slot:x' } },
          thoughtSignature: 'opaque-signature-abc',
        },
      ],
    })
  })
})
