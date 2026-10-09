import { supabaseAdmin } from './admin-client'
import { loadAgentForConversation } from './channel-agent'
import { buildConversationContext } from './context'
import { buildSystemPrompt } from './defaults'
import { generateReplyWithFallback } from './generate-with-fallback'
import { followupPromptSection, FOLLOWUP_USER_TURN } from './followup-prompt'
import { splitLongText } from './split-long'
import { logAiUsage } from './usage'
import { engineSendText } from '@/lib/flows/meta-send'
import type { AiConfig } from './types'

export interface AiFollowupStepConfig {
  /** Extra guidance for this step ("mencione o prazo da simulação"). */
  instruction?: string
  /** Last try: ask whether the customer wants the messages to stop. */
  final?: boolean
  /** Sent as-is if the model fails, instead of ending the sequence. */
  fallback_text?: string
}

/**
 * The `ai_followup` step: the account's own agent reads the conversation
 * and writes the nudge, so the reminder is about what was actually being
 * discussed. Runs only inside a follow-up run — the engine has already
 * re-checked reply / opt-out / window / cap / send window before calling.
 *
 * Throws on failure (the engine ends the enrollment) unless the step has a
 * fallback text.
 */
/** The follow-up stopped being due while the AI was writing it. */
export class FollowupNoLongerDue extends Error {
  constructor() {
    super('follow-up no longer due')
  }
}

export async function sendAiFollowup(args: {
  accountId: string
  userId: string
  conversationId: string
  contactId: string
  enrollmentId: string
  cfg: AiFollowupStepConfig
  /** Re-checked right before sending; false = drop the follow-up. */
  stillDue?: () => Promise<boolean>
}): Promise<{ messageId: string }> {
  const db = supabaseAdmin()
  const { accountId, conversationId, contactId, enrollmentId, cfg } = args

  const fallback = cfg.fallback_text?.trim() || null
  let first = ''
  const send = async (text: string, aiGenerated: boolean) => {
    const { whatsapp_message_id } = await engineSendText({
      accountId,
      userId: args.userId,
      conversationId,
      contactId,
      text,
      aiGenerated,
    })
    return { messageId: whatsapp_message_id }
  }

  try {
    const [{ data: enr }, { data: contact }] = await Promise.all([
      db.from('followup_enrollments').select('steps_sent').eq('id', enrollmentId).maybeSingle(),
      db.from('contacts').select('name').eq('id', contactId).eq('account_id', accountId).maybeSingle(),
    ])

    // Same persona the customer has been talking to — pinned, chosen by
    // the router, or bound to the number — like the auto-reply (A7).
    const config: AiConfig | null = await loadAgentForConversation(db, accountId, conversationId)
    if (!config) throw new Error('AI is not configured for this account')

    const history = await buildConversationContext(db, conversationId)
    if (history.length === 0) throw new Error('no conversation to follow up on')

    const systemPrompt = `${buildSystemPrompt({
      userPrompt: config.systemPrompt,
      mode: 'draft',
      contactName: contact?.name ?? null,
    })}\n\n${followupPromptSection({
      attempt: ((enr?.steps_sent as number | undefined) ?? 0) + 1,
      final: !!cfg.final,
      custom: cfg.instruction,
    })}`

    const generation = await generateReplyWithFallback({
      config,
      systemPrompt,
      messages: [...history, { role: 'user', content: FOLLOWUP_USER_TURN }],
    })
    void logAiUsage(db, {
      accountId,
      conversationId,
      agentId: config.id ?? null,
      mode: 'auto_reply',
      provider: generation.provider,
      model: generation.model,
      usage: generation.usage,
    })

    const text = generation.text?.trim()
    if (generation.handoff || !text) throw new Error('the model produced no follow-up text')

    // The model can take a while: re-check that the follow-up is still
    // due (the customer may have answered meanwhile) right before sending.
    if (args.stillDue && !(await args.stillDue())) {
      throw new FollowupNoLongerDue()
    }
    for (const part of splitLongText(text)) {
      const r = await send(part, true)
      first ||= r.messageId
    }
    return { messageId: first }
  } catch (err) {
    if (err instanceof FollowupNoLongerDue) throw err
    // The fallback replaces a follow-up that never went out — never a
    // second message after part of the AI text was delivered (A13).
    if (fallback && !first) return send(fallback, false)
    throw err
  }
}
