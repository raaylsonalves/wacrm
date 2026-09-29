import { AiError, type AiUsage } from './types'
import { normalizeUsage, providerHttpError, toNetworkError } from './providers/shared'
import { extensionForMime } from '@/lib/media/filename'

const OPENAI_TRANSCRIBE_URL = 'https://api.openai.com/v1/audio/transcriptions'

/** Small, cheap and good in Portuguese; a voice note is a few seconds of
 *  speech, so the smaller model is the right cost point. */
export const TRANSCRIBE_MODEL = 'gpt-4o-mini-transcribe'

/** Models an agent may pick for transcription. An allow-list rather than
 *  free text: a typo would fail every voice note, and the endpoint only
 *  serves these. Listing order = cheapest first. */
export const TRANSCRIPTION_MODELS = [
  'gpt-4o-mini-transcribe',
  'whisper-1',
  'gpt-4o-transcribe',
] as const
export type TranscriptionModel = (typeof TRANSCRIPTION_MODELS)[number]

/** A stored or submitted value → a known model, or null (= the default). */
export function parseTranscriptionModel(value: unknown): TranscriptionModel | null {
  return typeof value === 'string' &&
    (TRANSCRIPTION_MODELS as readonly string[]).includes(value)
    ? (value as TranscriptionModel)
    : null
}

/** A voice note answer is worth waiting for, but not past the webhook's
 *  own budget. */
const TRANSCRIBE_TIMEOUT_MS = 30_000

/**
 * Speech to text through the account's own OpenAI key (the same key it
 * already uses for the knowledge base). No language is forced: the model
 * detects it, and a customer may switch mid-conversation.
 *
 * Throws `AiError` on any provider/network failure or an empty result —
 * the caller turns that into "couldn't understand the audio".
 */
/** Same call, plus the token usage the transcription models report. */
export async function transcribeAudioWithUsage(
  args: Parameters<typeof transcribeAudio>[0],
): Promise<{ text: string; usage: AiUsage | null }> {
  let usage: AiUsage | null = null
  const text = await transcribeAudio({ ...args, onUsage: (u) => (usage = u) })
  return { text, usage }
}

export async function transcribeAudio(args: {
  apiKey: string
  bytes: Uint8Array
  mimeType: string | null
  /** The agent's choice; anything unknown falls back to the default. */
  model?: string | null
  /** ISO-639-1 hint ('pt'). Without it a short Portuguese note came back
   *  in Cyrillic. Omitted when unknown, letting the model detect. */
  language?: string | null
  timeoutMs?: number
  onUsage?: (usage: AiUsage) => void
}): Promise<string> {
  const { apiKey, bytes, mimeType, timeoutMs = TRANSCRIBE_TIMEOUT_MS } = args
  const model = parseTranscriptionModel(args.model) ?? TRANSCRIBE_MODEL

  const form = new FormData()
  form.append(
    'file',
    new Blob([bytes as BlobPart], { type: mimeType ?? 'application/octet-stream' }),
    `audio.${extensionForMime(mimeType)}`,
  )
  form.append('model', model)
  form.append('response_format', 'json')
  const lang = (args.language ?? '').trim().toLowerCase().slice(0, 2)
  if (/^[a-z]{2}$/.test(lang)) form.append('language', lang)

  let res: Response
  try {
    res = await fetch(OPENAI_TRANSCRIBE_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    throw toNetworkError(err)
  }
  if (!res.ok) throw await providerHttpError('OpenAI', res)

  const data = (await res.json().catch(() => null)) as {
    text?: unknown
    usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number }
  } | null
  const usage = normalizeUsage({
    prompt: data?.usage?.input_tokens,
    completion: data?.usage?.output_tokens,
    total: data?.usage?.total_tokens,
  })
  if (usage) args.onUsage?.(usage)
  const text = typeof data?.text === 'string' ? data.text.trim() : ''
  if (!text) {
    throw new AiError('The transcription came back empty.', { code: 'empty_response' })
  }
  return text
}
