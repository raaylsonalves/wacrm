import { describe, it, expect, vi, afterEach } from 'vitest'

vi.mock('@/lib/flows/meta-send', () => ({ engineSendMedia: vi.fn() }))

import {
  MAX_VOICE_CHARS,
  parseVoiceMode,
  parseVoiceName,
  sendVoiceReply,
  shouldReplyInVoice,
  synthesizeSpeech,
} from './voice-reply'

describe('shouldReplyInVoice', () => {
  it('only in mirror mode, only after audio, only when short', () => {
    expect(shouldReplyInVoice({ mode: 'mirror', inboundWasAudio: true, text: 'Oi!' })).toBe(true)
    expect(shouldReplyInVoice({ mode: 'off', inboundWasAudio: true, text: 'Oi!' })).toBe(false)
    expect(shouldReplyInVoice({ mode: 'mirror', inboundWasAudio: false, text: 'Oi!' })).toBe(false)
    expect(
      shouldReplyInVoice({ mode: 'mirror', inboundWasAudio: true, text: 'a'.repeat(MAX_VOICE_CHARS + 1) }),
    ).toBe(false)
    expect(shouldReplyInVoice({ mode: 'mirror', inboundWasAudio: true, text: '  ' })).toBe(false)
  })
})

describe('parsers', () => {
  it('unknown values fall back safely', () => {
    expect(parseVoiceMode('mirror')).toBe('mirror')
    expect(parseVoiceMode('always')).toBe('off')
    expect(parseVoiceName('nova')).toBe('nova')
    expect(parseVoiceName('robot')).toBeNull()
  })
})

describe('synthesizeSpeech', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('asks for Ogg/Opus with the chosen voice', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    })
    vi.stubGlobal('fetch', fetchMock)
    const bytes = await synthesizeSpeech({ apiKey: 'sk', text: 'olá', voice: 'nova' })
    expect(bytes.byteLength).toBe(3)
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body).toMatchObject({ response_format: 'opus', voice: 'nova', input: 'olá' })
  })

  it('an empty body is an error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) }))
    await expect(synthesizeSpeech({ apiKey: 'sk', text: 'x' })).rejects.toMatchObject({ code: 'empty_response' })
  })
})

describe('sendVoiceReply', () => {
  function fakeDb(uploadError: { message: string } | null = null) {
    const upload = vi.fn().mockResolvedValue({ error: uploadError })
    const db = {
      storage: {
        from: () => ({
          upload,
          getPublicUrl: () => ({ data: { publicUrl: 'https://cdn/x.ogg' } }),
        }),
      },
    }
    return { db: db as never, upload }
  }
  const base = { accountId: 'a', userId: 'u', conversationId: 'c', contactId: 'k', text: 'Oi!', apiKey: 'sk' }

  it('uploads audio/ogg and sends it as audio, keeping the text on the row', async () => {
    const { db, upload } = fakeDb()
    const send = vi.fn().mockResolvedValue({ whatsapp_message_id: 'w' })
    await sendVoiceReply(db, { ...base, synthesize: async () => new Uint8Array([9]), send })
    expect(upload.mock.calls[0][2]).toMatchObject({ contentType: 'audio/ogg' })
    expect(send.mock.calls[0][0]).toMatchObject({
      kind: 'audio',
      link: 'https://cdn/x.ogg',
      caption: 'Oi!',
      aiGenerated: true,
    })
  })

  it('throws when the upload fails, so the caller sends text', async () => {
    const { db } = fakeDb({ message: 'mime not allowed' })
    const send = vi.fn()
    await expect(
      sendVoiceReply(db, { ...base, synthesize: async () => new Uint8Array([9]), send }),
    ).rejects.toThrow('voice upload failed')
    expect(send).not.toHaveBeenCalled()
  })
})
