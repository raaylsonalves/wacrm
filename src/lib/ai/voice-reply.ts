// ============================================================
// Answer a voice note with a voice note (specs/ai-voice-replies.md,
// phase 2 — the pipeline). The reply TEXT is generated and guardrailed
// first; only then is it spoken, so nothing is voiced that the text path
// would not have sent. Any failure falls back to sending the text.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { AiError } from './types'
import { providerHttpError, toNetworkError } from './providers/shared'
import { buildMediaPath } from '@/lib/storage/upload-media'
import { engineSendMedia } from '@/lib/flows/meta-send'
import { toSpeechText, toWhatsAppFormat } from './whatsapp-format'

const OPENAI_SPEECH_URL = 'https://api.openai.com/v1/audio/speech'
export const TTS_MODEL = 'gpt-4o-mini-tts'

export const VOICE_REPLY_MODES = ['off', 'mirror'] as const
export type VoiceReplyMode = (typeof VOICE_REPLY_MODES)[number]

export const VOICES = [
  'alloy', 'ash', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer',
] as const
export type VoiceName = (typeof VOICES)[number]
export const DEFAULT_VOICE: VoiceName = 'coral'

/** Longer replies go out as text: a two-minute voice monologue is worse
 *  to receive than a paragraph. */
export const MAX_VOICE_CHARS = 600

export function parseVoiceMode(v: unknown): VoiceReplyMode {
  return v === 'mirror' ? 'mirror' : 'off'
}
export function parseVoiceName(v: unknown): VoiceName | null {
  return typeof v === 'string' && (VOICES as readonly string[]).includes(v)
    ? (v as VoiceName)
    : null
}

/** Voice only when the account turned it on, the customer spoke, and the
 *  answer is short enough to listen to. Pure. */
export function shouldReplyInVoice(args: {
  mode: VoiceReplyMode | null | undefined
  inboundWasAudio: boolean
  text: string
}): boolean {
  if (args.mode !== 'mirror' || !args.inboundWasAudio) return false
  const t = args.text.trim()
  return t.length > 0 && t.length <= MAX_VOICE_CHARS
}

/**
 * Text → Ogg/Opus bytes (what WhatsApp renders as a voice note), with the
 * account's own OpenAI key.
 */
export async function synthesizeSpeech(args: {
  apiKey: string
  text: string
  voice?: string | null
  timeoutMs?: number
}): Promise<Uint8Array> {
  let res: Response
  try {
    res = await fetch(OPENAI_SPEECH_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${args.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: TTS_MODEL,
        voice: parseVoiceName(args.voice) ?? DEFAULT_VOICE,
        input: args.text,
        response_format: 'opus',
      }),
      signal: AbortSignal.timeout(args.timeoutMs ?? 30_000),
    })
  } catch (err) {
    throw toNetworkError(err)
  }
  if (!res.ok) throw await providerHttpError('OpenAI', res)
  const bytes = new Uint8Array(await res.arrayBuffer())
  if (bytes.byteLength === 0) {
    throw new AiError('The speech came back empty.', { code: 'empty_response' })
  }
  return bytes
}

/**
 * Speak `text` and send it as a voice note. The message row keeps the
 * text (content_text) so the inbox shows what was said. Throws on any
 * failure — the caller sends the text instead.
 */
export async function sendVoiceReply(
  db: SupabaseClient,
  args: {
    accountId: string
    userId: string
    conversationId: string
    contactId: string
    text: string
    apiKey: string
    voice?: string | null
    synthesize?: typeof synthesizeSpeech
    send?: typeof engineSendMedia
  },
): Promise<void> {
  const synthesize = args.synthesize ?? synthesizeSpeech
  const send = args.send ?? engineSendMedia
  // Spoken without formatting symbols or URLs; the row keeps the text.
  const bytes = await synthesize({
    apiKey: args.apiKey,
    text: toSpeechText(args.text),
    voice: args.voice,
  })

  const path = buildMediaPath(args.accountId, 'voice-reply.ogg', Date.now(), 'ai-voice')
  const bucket = db.storage.from('chat-media')
  const { error } = await bucket.upload(path, bytes, {
    contentType: 'audio/ogg',
    cacheControl: '3600',
    upsert: false,
  })
  if (error) throw new Error(`voice upload failed: ${error.message}`)
  const {
    data: { publicUrl },
  } = bucket.getPublicUrl(path)
  if (!publicUrl) throw new Error('voice upload returned no URL')

  await send({
    accountId: args.accountId,
    userId: args.userId,
    conversationId: args.conversationId,
    contactId: args.contactId,
    kind: 'audio',
    link: publicUrl,
    // The row shows what was said: WhatsApp formatting, not the model's
    // raw Markdown (the text path gets the same conversion in generate).
    caption: toWhatsAppFormat(args.text),
    aiGenerated: true,
  })
}
