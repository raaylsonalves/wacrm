// ============================================================
// Inbound voice notes for the AI (specs/ai-audio-inbound.md).
//
// The AI only reads text, so a voice note is transcribed and then treated
// like anything the customer typed: the same handoff keywords, guardrails
// and follow-ups apply with no special cases.
//
// Cost note: this runs only AFTER auto-reply's eligibility gates, so an
// account with the AI off, or a thread a human owns, never pays to
// transcribe.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { getMediaUrl, downloadMedia } from '@/lib/whatsapp/meta-api'
import { loadEmbeddingsKey } from './config'
import { transcribeAudio } from './transcribe'
import { hashKey } from '@/lib/variant'

export interface InboundAudio {
  /** messages.id of the stored audio message. */
  messageRowId: string
  /** Meta's media id. */
  mediaId: string
  accessToken: string
}

export type AudioTranscription =
  | { status: 'done'; transcript: string }
  | { status: 'failed'; reason: 'no_key' | 'download' | 'transcribe' }

interface Deps {
  transcribe?: typeof transcribeAudio
  getUrl?: typeof getMediaUrl
  download?: typeof downloadMedia
}

/**
 * Transcribe one stored audio message and record the outcome on the row.
 * Never throws: every failure is a `failed` result, because the caller's
 * job is to answer the customer either way.
 */
export async function transcribeInboundAudio(
  db: SupabaseClient,
  accountId: string,
  audio: InboundAudio,
  /** The resolved agent's transcription model (null = default). */
  model: string | null = null,
  deps: Deps = {},
  /** The agent's own OpenAI key, when its provider is OpenAI. Preferred
   *  over the knowledge-base key, which is often left empty — that was
   *  why voice notes failed for an account already running on OpenAI. */
  openAiKey: string | null = null,
): Promise<AudioTranscription> {
  const { transcribe = transcribeAudio, getUrl = getMediaUrl, download = downloadMedia } = deps

  const record = async (
    result: AudioTranscription,
  ): Promise<AudioTranscription> => {
    try {
      await db
        .from('messages')
        .update({
          transcript: result.status === 'done' ? result.transcript : null,
          transcript_status: result.status,
        })
        .eq('id', audio.messageRowId)
    } catch (err) {
      console.warn('[ai audio] could not store the transcript:', err)
    }
    return result
  }

  const key = openAiKey || (await loadEmbeddingsKey(db, accountId)).key
  if (!key) return record({ status: 'failed', reason: 'no_key' })

  let bytes: Uint8Array
  let mimeType: string | null
  try {
    const info = await getUrl({ mediaId: audio.mediaId, accessToken: audio.accessToken })
    const file = await download({ downloadUrl: info.url, accessToken: audio.accessToken })
    bytes = file.buffer
    mimeType = info.mimeType || file.contentType
  } catch (err) {
    console.warn('[ai audio] could not fetch the audio:', err instanceof Error ? err.message : err)
    return record({ status: 'failed', reason: 'download' })
  }

  try {
    const transcript = await transcribe({
      apiKey: key,
      bytes,
      mimeType,
      model,
      // The deployment's locale (build-time, single-locale app).
      language: process.env.NEXT_PUBLIC_APP_LOCALE || null,
    })
    return record({ status: 'done', transcript })
  } catch (err) {
    console.warn('[ai audio] transcription failed:', err instanceof Error ? err.message : err)
    return record({ status: 'failed', reason: 'transcribe' })
  }
}

/** Wording for "I couldn't understand that audio — please write it",
 *  from `AiAudioNotice` in messages/<locale>.json. Same variant rule as
 *  the handoff notice: stable per conversation. Null = no wording, so a
 *  missing translation means "say nothing", never a raw key. */
export function audioRetryText(dict: unknown, leadKey: string): string | null {
  if (!dict || typeof dict !== 'object') return null
  const group = (dict as Record<string, unknown>).retry
  if (!group || typeof group !== 'object') return null
  const pool = Object.entries(group as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, v]) => v)
    .filter((v): v is string => typeof v === 'string' && v.trim() !== '')
  if (pool.length === 0) return null
  return pool[hashKey(leadKey) % pool.length]
}

export async function loadAudioRetryText(
  leadKey: string,
  locale: string = process.env.NEXT_PUBLIC_APP_LOCALE || 'en',
): Promise<string | null> {
  try {
    const messages = (await import(`../../../messages/${locale}.json`)).default
    return audioRetryText(messages?.AiAudioNotice, leadKey)
  } catch {
    return null
  }
}
