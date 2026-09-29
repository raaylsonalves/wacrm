import type { SupabaseClient } from '@supabase/supabase-js'
import type { ChatMessage } from './types'
import { aiContextMessageLimit } from './defaults'

/** Prefix on a transcribed voice note in the model's transcript. */
export const AUDIO_MARK = '[áudio transcrito]'

interface DbMessage {
  sender_type: 'customer' | 'agent' | 'bot'
  content_type: string
  content_text: string | null
  interactive_reply_id: string | null
  transcript: string | null
}

/**
 * Fetch the last N text (+ interactive-tap) messages of a conversation
 * and map them to the provider-neutral chat shape. Customer messages
 * become `user`; agent and bot messages become `assistant`. Media and
 * template messages are excluded — they carry no text to model.
 *
 * A button/list tap (`content_type = 'interactive'`) is included: its
 * `content_text` already holds the human-readable row/button title
 * (see the webhook's `parseMessageContent`), so it reads as a normal
 * turn — "ter 24/09 09:30" rather than being invisible to the model.
 * When the tap carries a stable `interactive_reply_id` (every customer
 * tap does; a bot's own interactive prompt never does), it's appended
 * as `(id: ...)` so a later turn — e.g. the agenda tools,
 * specs/ai-agenda-tool-calling.md — can quote the exact id back
 * instead of re-deriving it from the label.
 *
 * A voice note enters as its transcript (`messages.transcript`, written by
 * audio-inbound.ts), marked so the model knows it was spoken. An audio
 * message with no transcript stays out, like any media.
 *
 * Ordered oldest-first (chronological) so the transcript reads
 * naturally and the most recent customer message lands last.
 */
export async function buildConversationContext(
  db: SupabaseClient,
  conversationId: string,
  limit: number = aiContextMessageLimit(),
): Promise<ChatMessage[]> {
  const { data, error } = await db
    .from('messages')
    .select('sender_type, content_type, content_text, interactive_reply_id, transcript')
    .eq('conversation_id', conversationId)
    .in('content_type', ['text', 'interactive', 'audio'])
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) throw error

  const rows = ((data ?? []) as DbMessage[]).reverse()
  return rows
    .map((m) => ({
      ...m,
      text: m.content_type === 'audio' ? m.transcript : m.content_text,
    }))
    .filter((m) => m.text && m.text.trim())
    .map((m) => {
      const spoken = m.content_type === 'audio' ? `${AUDIO_MARK} ${m.text!.trim()}` : m.text!.trim()
      const content = m.interactive_reply_id
        ? `${spoken} (id: ${m.interactive_reply_id})`
        : spoken
      return {
        role: m.sender_type === 'customer' ? 'user' : 'assistant',
        content,
      }
    })
}
