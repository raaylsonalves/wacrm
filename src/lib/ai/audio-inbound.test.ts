import { describe, it, expect, vi } from 'vitest'

vi.mock('./config', () => ({ loadEmbeddingsKey: vi.fn() }))

import { loadEmbeddingsKey } from './config'
import { audioRetryText, transcribeInboundAudio } from './audio-inbound'

function fakeDb() {
  const updates: Record<string, unknown>[] = []
  const db = {
    from: () => ({
      update: (payload: Record<string, unknown>) => {
        updates.push(payload)
        return { eq: () => Promise.resolve({ error: null }) }
      },
    }),
  }
  return { db: db as never, updates }
}

const audio = { messageRowId: 'm1', mediaId: 'media1', accessToken: 'tok' }
const getUrl = vi.fn().mockResolvedValue({ url: 'https://x', mimeType: 'audio/ogg; codecs=opus', fileSize: 1 })
const download = vi.fn().mockResolvedValue({ buffer: Buffer.from('a'), contentType: 'audio/ogg' })

describe('transcribeInboundAudio', () => {
  it('transcribes and stores the transcript on the message', async () => {
    vi.mocked(loadEmbeddingsKey).mockResolvedValue({ key: 'sk-test', corrupt: false })
    const { db, updates } = fakeDb()
    const transcribe = vi.fn().mockResolvedValue('quero agendar para terça')
    const r = await transcribeInboundAudio(db, 'acc', audio, { transcribe, getUrl, download })
    expect(r).toEqual({ status: 'done', transcript: 'quero agendar para terça' })
    expect(updates[0]).toEqual({ transcript: 'quero agendar para terça', transcript_status: 'done' })
    expect(transcribe.mock.calls[0][0].mimeType).toBe('audio/ogg; codecs=opus')
  })

  it('fails without an OpenAI key, and says so on the row', async () => {
    vi.mocked(loadEmbeddingsKey).mockResolvedValue({ key: null, corrupt: false })
    const { db, updates } = fakeDb()
    const transcribe = vi.fn()
    const r = await transcribeInboundAudio(db, 'acc', audio, { transcribe, getUrl, download })
    expect(r).toEqual({ status: 'failed', reason: 'no_key' })
    expect(transcribe).not.toHaveBeenCalled()
    expect(updates[0]).toEqual({ transcript: null, transcript_status: 'failed' })
  })

  it('a failing provider is a failed result, never a throw', async () => {
    vi.mocked(loadEmbeddingsKey).mockResolvedValue({ key: 'sk-test', corrupt: false })
    const { db } = fakeDb()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const transcribe = vi.fn().mockRejectedValue(new Error('boom'))
    const r = await transcribeInboundAudio(db, 'acc', audio, { transcribe, getUrl, download })
    expect(r).toEqual({ status: 'failed', reason: 'transcribe' })
    warn.mockRestore()
  })

  it('a failed download is a failed result', async () => {
    vi.mocked(loadEmbeddingsKey).mockResolvedValue({ key: 'sk-test', corrupt: false })
    const { db } = fakeDb()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const bad = vi.fn().mockRejectedValue(new Error('404'))
    const r = await transcribeInboundAudio(db, 'acc', audio, { getUrl: bad, download })
    expect(r).toEqual({ status: 'failed', reason: 'download' })
    warn.mockRestore()
  })
})

describe('audioRetryText', () => {
  const dict = { retry: { v1: 'um', v2: 'dois' } }
  it('is stable per conversation', () => {
    expect(audioRetryText(dict, 'c-1')).toBe(audioRetryText(dict, 'c-1'))
  })
  it('degrades to null when there is no wording', () => {
    expect(audioRetryText(undefined, 'c')).toBeNull()
    expect(audioRetryText({ retry: {} }, 'c')).toBeNull()
  })
})
