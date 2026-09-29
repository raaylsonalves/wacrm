import { describe, it, expect, vi, afterEach } from 'vitest'
import { TRANSCRIBE_MODEL, parseTranscriptionModel, transcribeAudio } from './transcribe'

describe('parseTranscriptionModel', () => {
  it('accepts the listed models', () => {
    expect(parseTranscriptionModel('whisper-1')).toBe('whisper-1')
    expect(parseTranscriptionModel('gpt-4o-transcribe')).toBe('gpt-4o-transcribe')
  })
  it('turns anything else into null (= the default)', () => {
    expect(parseTranscriptionModel('gpt-5-turbo')).toBeNull()
    expect(parseTranscriptionModel('')).toBeNull()
    expect(parseTranscriptionModel(undefined)).toBeNull()
    expect(parseTranscriptionModel(42)).toBeNull()
  })
})

describe('transcribeAudio', () => {
  afterEach(() => vi.unstubAllGlobals())

  function stubFetch(body: unknown, ok = true) {
    const fetchMock = vi.fn().mockResolvedValue({
      ok,
      status: ok ? 200 : 500,
      json: async () => body,
      text: async () => JSON.stringify(body),
    })
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }
  const bytes = new Uint8Array([1, 2, 3])

  it('sends the chosen model and returns the trimmed text', async () => {
    const fetchMock = stubFetch({ text: '  oi, tudo bem  ' })
    const text = await transcribeAudio({
      apiKey: 'sk-x',
      bytes,
      mimeType: 'audio/ogg; codecs=opus',
      model: 'whisper-1',
    })
    expect(text).toBe('oi, tudo bem')
    const form = fetchMock.mock.calls[0][1].body as FormData
    expect(form.get('model')).toBe('whisper-1')
    expect((form.get('file') as File).name).toBe('audio.ogg')
  })

  it('falls back to the default model when the choice is unknown', async () => {
    const fetchMock = stubFetch({ text: 'ok' })
    await transcribeAudio({ apiKey: 'sk-x', bytes, mimeType: 'audio/ogg', model: 'nope' })
    expect((fetchMock.mock.calls[0][1].body as FormData).get('model')).toBe(TRANSCRIBE_MODEL)
  })

  it('an empty transcript is an error, not an empty message', async () => {
    stubFetch({ text: '   ' })
    await expect(
      transcribeAudio({ apiKey: 'sk-x', bytes, mimeType: 'audio/ogg' }),
    ).rejects.toMatchObject({ code: 'empty_response' })
  })
})
