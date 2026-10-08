import type { SupabaseClient } from '@supabase/supabase-js'
import type { ChatMessage } from './types'
import { aiContextMessageLimit } from './defaults'

/** Prefix on a transcribed voice note in the model's transcript. */
export const AUDIO_MARK = '[áudio transcrito]'

/** Prefix on a template/broadcast the business sent. */
export const TEMPLATE_MARK = '[modelo enviado]'

/**
 * Business turns this agent did not write are labelled with their author
 * (a person on the team, another AI agent, an automation), so an agent
 * picking up a conversation another one handled — the router moved it,
 * or a human stepped in — keeps its own role and does not take their
 * words as its own promises. Every label starts with this.
 */
export const AUTHOR_MARK_PREFIX = '[enviada por '
const HUMAN_MARK = '[enviada por um atendente humano]'
const AUTOMATION_MARK = '[enviada por uma automação]'
const agentMark = (name: string) => `[enviada pelo agente "${name}"]`

/** Explains the labels to the model (added only when one appears). */
export const AUTHOR_MARKS_PROMPT =
  'Algumas mensagens anteriores da empresa começam com "[enviada por …]": ' +
  'elas foram escritas por um atendente humano, por outro agente de IA ou ' +
  'por uma automação, não por você. Leve em conta o que foi dito, mas ' +
  'mantenha o seu papel e nunca repita essas marcações nas suas respostas.'

interface DbMessage {
  sender_type: 'customer' | 'agent' | 'bot'
  content_type: string
  content_text: string | null
  interactive_reply_id: string | null
  transcript: string | null
  ai_generated?: boolean | null
  ai_agent_id?: string | null
}

/**
 * Fetch the last N text (+ interactive-tap) messages of a conversation
 * and map them to the provider-neutral chat shape. Customer messages
 * become `user`; agent and bot messages become `assistant`. Media and
 * template messages without text are excluded.
 *
 * A sent template (a broadcast, recorded by broadcast-record.ts) enters
 * as the business's turn, marked so the model knows it was a campaign
 * message: a customer answering "can you explain what you sent?" used to
 * reach a model that had never seen it, and it handed off.
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
  // When set, business turns not written by this agent are labelled with
  // their author (see AUTHOR_MARK_PREFIX). Draft/summary callers omit it
  // and get the plain transcript, as before.
  opts: { selfAgentId?: string | null } = {},
): Promise<ChatMessage[]> {
  const { data, error } = await db
    .from('messages')
    .select(
      'sender_type, content_type, content_text, interactive_reply_id, transcript, ai_generated, ai_agent_id',
    )
    .eq('conversation_id', conversationId)
    .in('content_type', ['text', 'interactive', 'audio', 'template'])
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) throw error

  const rows = ((data ?? []) as DbMessage[]).reverse()

  const labelled = opts.selfAgentId !== undefined
  // Names of the OTHER agents that wrote in this window, one query.
  const otherAgents = labelled
    ? [
        ...new Set(
          rows
            .map((r) => r.ai_agent_id)
            .filter((id): id is string => !!id && id !== opts.selfAgentId),
        ),
      ]
    : []
  const agentNames = new Map<string, string>()
  if (otherAgents.length > 0) {
    const { data: agents } = await db
      .from('ai_configs')
      .select('id, name')
      .in('id', otherAgents)
    for (const a of (agents ?? []) as { id: string; name: string | null }[])
      agentNames.set(a.id, a.name || 'outro agente')
  }
  const authorMark = (m: DbMessage): string | null => {
    if (!labelled || m.sender_type === 'customer') return null
    if (m.sender_type === 'agent') return HUMAN_MARK
    if (m.ai_agent_id && m.ai_agent_id !== opts.selfAgentId)
      return agentMark(agentNames.get(m.ai_agent_id) ?? 'outro agente')
    // An AI turn with no agent recorded (before migration 114) or this
    // agent's own: unlabelled. A bot turn that is not AI is automation.
    if (!m.ai_agent_id && !m.ai_generated && m.content_type !== 'template')
      return AUTOMATION_MARK
    return null
  }

  return rows
    .map((m) => ({
      ...m,
      text: m.content_type === 'audio' ? m.transcript : m.content_text,
    }))
    .filter((m) => m.text && m.text.trim())
    .map((m) => {
      const spoken =
        m.content_type === 'audio'
          ? `${AUDIO_MARK} ${m.text!.trim()}`
          : m.content_type === 'template'
            ? `${TEMPLATE_MARK} ${m.text!.trim()}`
            : m.text!.trim()
      const tapped = m.interactive_reply_id
        ? `${spoken} (id: ${m.interactive_reply_id})`
        : spoken
      const mark = authorMark(m)
      const content = mark ? `${mark} ${tapped}` : tapped
      return {
        role: m.sender_type === 'customer' ? 'user' : 'assistant',
        content,
      }
    })
}
