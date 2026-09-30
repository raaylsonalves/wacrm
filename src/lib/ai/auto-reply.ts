import { supabaseAdmin } from './admin-client'
import { adminsFor, notifyUsers, teamForConversation } from '@/lib/notifications/notify'
import { loadAiConfig } from './config'
import { loadActiveRouterForChannel, resolveAgentViaRouter } from './router'
import { buildConversationContext, AUDIO_MARK } from './context'
import { loadChannelAgentId } from './channel-agent'
import { matchHandoffKeyword } from './handoff-keywords'
import { splitLongText } from './split-long'
import { observeBeforeSend } from './guardrails/observe'
import { classifyAcknowledgment, shouldSkipAcknowledgment } from './ack'
import { loadNoticeText } from './notice-text'
import { waitForQuietPeriod } from './burst'
import { TTS_MODEL, sendVoiceReply, shouldReplyInVoice } from './voice-reply'
import { TRANSCRIBE_MODEL } from './transcribe'
import { loadEmbeddingsKey } from './config'
import {
  loadAudioRetryText,
  transcribeInboundAudio,
  type InboundAudio,
} from './audio-inbound'
import { retrieveKnowledge } from './knowledge'
import {
  generateReplyWithFallback,
  AllProvidersFailedError,
} from './generate-with-fallback'
import { buildSystemPrompt } from './defaults'
import {
  buildHandoffMeta,
  lastCustomerMessage,
  type HandoffMeta,
  type HandoffReason,
} from './handoff'
import {
  handoffNoticeText,
  isTeamOnline,
  loadHandoffNoticeDict,
} from './handoff-notice'
import { isOptOutMessage } from '@/lib/contacts/opt-out'
import { confirmOptOut } from '@/lib/contacts/opt-out-confirm'
import type { AiConfig } from './types'
import { logAiUsage } from './usage'
import { latestUserMessage } from './query'
import { AGENDA_TOOLS, createAgendaToolExecutor } from './tools/agenda'
import { CONTACT_TOOLS, createContactToolExecutor } from './tools/contact'
import {
  CASE_TOOLS,
  casesPromptSection,
  createCaseToolExecutor,
  loadOpenCases,
} from './tools/cases'
import { openCase } from '@/lib/cases/store'
import { promisesHumanFollowUp } from './guardrails/gates'
import {
  PROSPECTING_TOOLS,
  createProspectingToolExecutor,
  loadProspectContext,
  prospectPromptLine,
} from './tools/prospecting'
import {
  engineSendText,
  loadAccountMetaCredentials,
} from '@/lib/flows/meta-send'
import { sendTypingIndicator } from '@/lib/whatsapp/meta-api'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'

/** Pause between successive bubbles of a split reply — long enough to
 *  read as a person pausing between messages, short enough that a
 *  3-bubble reply still fully lands in a couple of seconds. */
const SEGMENT_DELAY_MS = 1200

/**
 * Stop the bot on this thread and route it to a human — the single
 * mechanism behind every way auto-reply gives up: the model itself
 * asking to hand off, every configured provider failing, the
 * per-conversation reply cap or the account-wide rate limit being hit,
 * or an internal error reserving the reply. (a) pauses the bot here
 * (sticky until re-enabled from the inbox), (b) routes to the
 * configured handoff agent — null leaves it in the shared queue —
 * without stomping an existing human assignment, (c) records the
 * *reason* (rendered localized by the inbox banner — never a finished
 * English sentence), and (d) tells the customer a person is taking
 * over, so they aren't left in silence
 * (specs/handoff-customer-notice.md). Assigning fires the
 * `on_conversation_assigned` trigger, which notifies the agent — this
 * is the only "someone should look at this" signal in every one of
 * these paths, so skipping it (as the reply-cap path used to) silently
 * strands the conversation.
 */
export async function handOffToHuman(
  db: ReturnType<typeof supabaseAdmin>,
  conversationId: string,
  config: Pick<AiConfig, 'handoffAgentId'>,
  currentAssignedAgentId: string | null,
  reason: HandoffReason,
  meta: HandoffMeta,
  notice: NoticeContext,
): Promise<void> {
  const update: Record<string, unknown> = {
    ai_autoreply_disabled: true,
    ai_handoff_reason: reason,
    ai_handoff_meta: meta,
    // New writes leave the legacy free-text note empty; the banner falls
    // back to it only for rows written before migration 072.
    ai_handoff_summary: null,
  }
  if (config.handoffAgentId && !currentAssignedAgentId) {
    update.assigned_agent_id = config.handoffAgentId
  }
  await db.from('conversations').update(update).eq('id', conversationId)

  // With nobody assigned, the assignment trigger fires no alert — tell the
  // team the AI stopped. A provider outage also pages the admins, whose
  // key / billing it usually is. Grouped, so an outage is one row.
  await notifyHandoff(db, conversationId, reason, notice, !!(currentAssignedAgentId || update.assigned_agent_id))

  // Order matters: the handoff state is written FIRST and the notice is
  // best-effort after it. A failed send must never leave the
  // conversation half-handed-off — fail closed on the action, open on
  // the information (recorded on the row for the banner).
  await notifyCustomerOfHandoff(db, conversationId, currentAssignedAgentId, meta, notice)
}

async function notifyHandoff(
  db: ReturnType<typeof supabaseAdmin>,
  conversationId: string,
  reason: HandoffReason,
  notice: NoticeContext,
  assigned: boolean,
): Promise<void> {
  try {
    if (!assigned) {
      const { data: contact } = await db
        .from('contacts')
        .select('name, phone')
        .eq('id', notice.contactId)
        .maybeSingle()
      await notifyUsers(db, {
        accountId: notice.accountId,
        userIds: await teamForConversation(db, notice.accountId, conversationId),
        type: 'handoff_waiting',
        conversationId,
        contactId: notice.contactId,
        contactName: (contact?.name as string | null) || (contact?.phone as string | null) || null,
        data: { handoff_reason: reason },
        link: `/inbox?c=${conversationId}`,
        groupKey: `handoff:${conversationId}`,
      })
    }
    if (reason === 'provider_failure') {
      await notifyUsers(db, {
        accountId: notice.accountId,
        userIds: await adminsFor(db, notice.accountId),
        type: 'ai_provider_failed',
        link: '/agents',
        groupKey: `ai_fail:${notice.accountId}`,
      })
    }
  } catch (err) {
    console.warn('[auto-reply] hand-off notification failed:', err)
  }
}

/** Pause before the single retry of a failed reply bubble. */
const SEND_RETRY_DELAY_MS = 2000

export interface NoticeContext {
  accountId: string
  contactId: string
  /** WhatsApp config owner — the outbound send's audit user. */
  userId: string
}

/**
 * Tell the customer the conversation moved to a person. Never throws.
 *
 * Skipped when a human already owns the thread (they are talking to the
 * customer), when the customer opted out and this message isn't the
 * opt-out itself, and when another concurrent handoff already claimed
 * the notice. Sent at most once per handoff: the claim flips
 * `ai_handoff_customer_notified` from NULL, and "Resume AI" resets it
 * so a later handoff can notify again.
 */
async function notifyCustomerOfHandoff(
  db: ReturnType<typeof supabaseAdmin>,
  conversationId: string,
  currentAssignedAgentId: string | null,
  meta: HandoffMeta,
  ctx: NoticeContext,
): Promise<void> {
  try {
    if (currentAssignedAgentId) return

    const { data: claimed } = await db
      .from('conversations')
      .update({ ai_handoff_customer_notified: false })
      .eq('id', conversationId)
      .is('ai_handoff_customer_notified', null)
      .select('id')
    if (!claimed || claimed.length === 0) return

    const skip = async (why: string) => {
      await db
        .from('conversations')
        .update({ ai_handoff_notice_skipped_reason: why })
        .eq('id', conversationId)
    }

    const { data: contact } = await db
      .from('contacts')
      .select('opted_out_at')
      .eq('id', ctx.contactId)
      .eq('account_id', ctx.accountId)
      .maybeSingle()

    // The customer's own opt-out gets a confirmation; a contact who opted
    // out earlier gets nothing at all.
    const optOut = isOptOutMessage(meta.lastCustomerMessage ?? '')
    if (!optOut && contact?.opted_out_at) {
      await skip('opted_out')
      return
    }
    // STOP: the webhook already confirmed it (or does it here, if it
    // could not) — one shared claim, so the customer never gets two
    // confirmations (migration 101).
    if (optOut) {
      const r = await confirmOptOut(db, {
        accountId: ctx.accountId,
        contactId: ctx.contactId,
        conversationId,
        userId: ctx.userId,
      })
      if (r === 'failed') return skip('send_failed')
      if (r === 'no_text') return skip('no_notice_text')
      await db
        .from('conversations')
        .update({ ai_handoff_customer_notified: true, ai_handoff_notice_skipped_reason: null })
        .eq('id', conversationId)
      return
    }

    const [dict, teamOnline] = await Promise.all([
      loadHandoffNoticeDict(),
      isTeamOnline(db, ctx.accountId),
    ])
    const text = handoffNoticeText({
      optOut,
      teamOnline,
      leadKey: conversationId,
      dict,
    })
    if (!text) {
      await skip('no_notice_text')
      return
    }

    try {
      await engineSendText({
        accountId: ctx.accountId,
        userId: ctx.userId,
        conversationId,
        contactId: ctx.contactId,
        text,
        aiGenerated: true,
      })
    } catch (err) {
      console.warn(`[ai auto-reply ${conversationId}] handoff notice failed:`, err)
      await skip('send_failed')
      return
    }
    await db
      .from('conversations')
      .update({
        ai_handoff_customer_notified: true,
        ai_handoff_notice_skipped_reason: null,
      })
      .eq('id', conversationId)
  } catch (err) {
    console.warn(`[ai auto-reply ${conversationId}] handoff notice errored:`, err)
  }
}

interface DispatchArgs {
  /** Tenancy key — drives config, contact, and whatsapp_config lookups. */
  accountId: string
  conversationId: string
  contactId: string
  /** The account's WhatsApp config owner, used for the outbound send's
   *  audit columns (mirrors how the flow runner passes it through). */
  configOwnerUserId: string
  /** Meta's wamid of the customer message we're replying to. When set,
   *  a typing indicator (which also marks it read) is shown while the
   *  reply is generated. Optional so older callers keep working. */
  inboundMessageId?: string
  /** The inbound message is a voice note. It is transcribed here, AFTER
   *  the eligibility gates, so an account with the AI off never pays to
   *  transcribe (specs/ai-audio-inbound.md). */
  audio?: InboundAudio
  /** Answer right away instead of waiting out a burst — a button/list tap
   *  is one deliberate action, never the first of several messages. */
  immediate?: boolean
}

/**
 * AI auto-reply for a freshly-arrived inbound message.
 *
 * Invoked from the WhatsApp webhook's `after()` block, only when no
 * deterministic flow consumed the message (flows win). Mirrors the flow
 * runner's contract: it owns its try/catch and NEVER throws — a failing
 * or slow LLM call must not affect the webhook's 200 to Meta.
 *
 * Eligibility gates (any → silent no-op):
 *   - AI off / auto-reply disabled for the account
 *   - a human agent is assigned (they own the thread)
 *   - auto-reply was disabled for this conversation (prior handoff)
 *   - the per-conversation reply cap is reached
 *   - there's nothing to reply to
 *
 * The 24h WhatsApp session window is inherently open here — we're
 * reacting to a customer message that just landed — so no separate
 * window check is needed.
 */
export async function dispatchInboundToAiReply(
  args: DispatchArgs,
): Promise<void> {
  const {
    accountId,
    conversationId,
    contactId,
    configOwnerUserId,
    inboundMessageId,
  } = args

  // Short, greppable prefix carrying the conversation id on every line so
  // a Vercel log stream filtered to one conversation shows the whole
  // trail — which gate (if any) stopped the dispatch, and how long the
  // generation itself took. Added after a live debugging session where
  // "typing shown, no reply, no visible error" gave no way to tell a
  // silent early-out apart from a hang without querying the DB by hand.
  const tag = `[ai auto-reply ${conversationId}]`
  const noticeCtx: NoticeContext = {
    accountId,
    contactId,
    userId: configOwnerUserId,
  }

  try {
    const db = supabaseAdmin()

    let config = await loadAiConfig(db, accountId)
    if (!config || !config.autoReplyEnabled) {
      console.info(`${tag} skipped: AI not configured or auto-reply disabled`)
      return
    }

    // Deterministic, user-configured responders win over the LLM — the
    // caller already excludes messages a Flow consumed. Message-level
    // automations (`new_message_received` / `keyword_match`) are
    // dispatched independently for this same inbound and may send their
    // own reply, so if the account has any active one we stand down to
    // avoid double-texting the customer. (Relationship triggers like
    // `first_inbound_message` don't count — they're not per-message
    // auto-responders.)
    const { data: autoResponders } = await db
      .from('automations')
      .select('id')
      .eq('account_id', accountId)
      .eq('is_active', true)
      .in('trigger_type', ['new_message_received', 'keyword_match'])
      .limit(1)
    if (autoResponders && autoResponders.length > 0) {
      console.info(`${tag} skipped: an active new_message_received/keyword_match automation owns this inbound`)
      return
    }

    const { data: conv, error: convErr } = await db
      .from('conversations')
      .select(
        'assigned_agent_id, ai_autoreply_disabled, ai_reply_count, whatsapp_channel_id, active_ai_agent_id, pinned_ai_agent_id',
      )
      .eq('id', conversationId)
      .maybeSingle()
    if (convErr || !conv) {
      console.info(`${tag} skipped: conversation lookup failed`, convErr)
      return
    }
    if (conv.assigned_agent_id) {
      console.info(`${tag} skipped: a human agent is assigned`)
      return // a human owns this thread
    }
    if (conv.ai_autoreply_disabled) {
      console.info(`${tag} skipped: auto-reply is disabled on this conversation (paused/handed off)`)
      return // handed off / turned off here
    }

    let routed = false

    // A conversation opened by a prospecting campaign is answered by the
    // campaign's own agent — the one that wrote the approach — ahead of
    // the router and the per-number binding. Same rule as a binding: if
    // that agent is off or gone, the AI stays silent rather than answer
    // with someone else's persona.
    if (conv.pinned_ai_agent_id && conv.pinned_ai_agent_id !== config.id) {
      let pinned: AiConfig | null = null
      try {
        pinned = await loadAiConfig(db, accountId, { agentId: conv.pinned_ai_agent_id })
      } catch (err) {
        console.warn(`${tag} pinned agent could not be loaded:`, err)
      }
      if (!pinned || !pinned.autoReplyEnabled) {
        console.info(`${tag} skipped: the agent pinned to this conversation is off or unavailable`)
        return
      }
      config = pinned
      routed = true
    } else if (conv.pinned_ai_agent_id) {
      routed = true
    }

    // Multi-agent router (specs/multi-agent-router.md) — inert for any
    // account with no active router (the common case today): resolves
    // to null and `config` stays the account's default agent, exactly
    // as before this feature existed. When active, whichever agent it
    // resolves to takes over the cap/handoff/claim logic below, which
    // is why this runs before all three.
    if (!routed) try {
      const activeRouter = await loadActiveRouterForChannel(
        db,
        accountId,
        conv.whatsapp_channel_id ?? null,
      )
      if (activeRouter) {
        const { data: latestInbound } = await db
          .from('messages')
          .select('content_text')
          .eq('conversation_id', conversationId)
          .eq('sender_type', 'contact')
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle()
        config = await resolveAgentViaRouter({
          db,
          accountId,
          conversationId,
          defaultConfig: config,
          activeRouter,
          currentAgentId: conv.active_ai_agent_id ?? null,
          messageText: latestInbound?.content_text ?? '',
        })
        routed = true
      }
    } catch (err) {
      // Doctrine (spec's "erro no classificador nunca derruba o
      // turno"): any failure resolving the router falls back to the
      // default agent already loaded above, not a dropped reply.
      console.warn(`${tag} router resolution failed, using default agent:`, err)
    }

    // The agent bound to THIS number (specs/ai-agents-management.md;
    // migration 074) — for a small business with two numbers, or an
    // operator running several clients' numbers, "this number → this
    // agent" without building a classifier. A router that took over above
    // wins (it is the more specific instruction); otherwise a binding
    // beats the account's default agent.
    //
    // A bound agent that is off, has no key, or can't be loaded means the
    // AI stays SILENT on that number rather than falling back to the
    // default agent: answering a barbershop's customers with another
    // client's persona is worse than not answering (a human still sees the
    // message).
    if (!routed) {
      const boundId = await loadChannelAgentId(
        db,
        accountId,
        conv.whatsapp_channel_id ?? null,
      )
      if (boundId && boundId !== config.id) {
        let bound: AiConfig | null = null
        try {
          bound = await loadAiConfig(db, accountId, { agentId: boundId })
        } catch (err) {
          console.warn(`${tag} bound agent could not be loaded:`, err)
        }
        if (!bound || !bound.autoReplyEnabled) {
          console.info(
            `${tag} skipped: the agent bound to this number is off or unavailable`,
          )
          return
        }
        config = bound
      }
    }

    // Cheap early-out; the authoritative cap check is the atomic claim
    // below (this read can race a concurrent inbound). Reaching the cap
    // hands off to a human here — the settings copy already promises
    // this ("...ou atinge o limite de respostas — ele pausa e
    // encaminha a conversa"), so silently going quiet instead would be
    // a customer message nobody is ever notified about.
    if (conv.ai_reply_count >= config.autoReplyMaxPerConversation) {
      console.info(`${tag} hands off: reached the per-conversation reply cap (${config.autoReplyMaxPerConversation})`)
      await handOffToHuman(
        db,
        conversationId,
        config,
        conv.assigned_agent_id,
        'reply_cap',
        buildHandoffMeta({
          replyCount: conv.ai_reply_count ?? 0,
          max: config.autoReplyMaxPerConversation,
        }),
        noticeCtx,
      )
      return
    }

    if (args.audio) {
      const heard = await transcribeInboundAudio(
        db,
        accountId,
        args.audio,
        config.transcriptionModel ?? null,
        {},
        config.provider === 'openai' ? config.apiKey : null,
      )
      if (heard.status === 'done' && heard.usage) {
        void logAiUsage(db, {
          accountId,
          conversationId,
          agentId: config.id ?? null,
          mode: 'auto_reply',
          provider: 'openai',
          model: config.transcriptionModel ?? TRANSCRIBE_MODEL,
          usage: heard.usage,
          kind: 'transcription',
        })
      }
      if (heard.status === 'failed') {
        console.info(`${tag} audio could not be transcribed (${heard.reason})`)
        // First time: say so and ask for text. If the customer's PREVIOUS
        // message was also an audio we could not read, stop asking and
        // hand the thread to a person. Not counted against the reply cap.
        const { data: recent } = await db
          .from('messages')
          .select('transcript_status')
          .eq('conversation_id', conversationId)
          .eq('sender_type', 'customer')
          .order('created_at', { ascending: false })
          .limit(2)
        const repeated = recent?.[1]?.transcript_status === 'failed'
        const retryText = repeated ? null : await loadAudioRetryText(conversationId)
        let asked = false
        if (retryText) {
          try {
            await engineSendText({
              accountId,
              userId: configOwnerUserId,
              conversationId,
              contactId,
              text: retryText,
              aiGenerated: true,
            })
            asked = true
          } catch (sendErr) {
            console.error(`${tag} could not send the audio retry message:`, sendErr)
          }
        }
        if (!asked) {
          await handOffToHuman(
            db,
            conversationId,
            config,
            conv.assigned_agent_id,
            'audio_unintelligible',
            buildHandoffMeta({ replyCount: conv.ai_reply_count ?? 0 }),
            noticeCtx,
          )
        }
        return
      }
    }

    // Burst coalescing (specs/ai-token-economy.md): wait a few seconds and
    // let only the dispatch of the NEWEST customer message answer, with the
    // whole burst in context. After the audio block on purpose: a voice
    // note that a later message supersedes is still transcribed, so the
    // surviving dispatch can read it.
    if (!args.immediate) {
      const quiet = await waitForQuietPeriod(db, { conversationId, inboundMessageId })
      if (quiet === 'superseded') {
        console.info(`${tag} skipped: a newer message arrived — its dispatch answers the whole burst`)
        return
      }
      // The world may have changed while we waited (a person took over, a
      // handoff paused the bot, another reply landed).
      const { data: fresh } = await db
        .from('conversations')
        .select('assigned_agent_id, ai_autoreply_disabled, ai_reply_count')
        .eq('id', conversationId)
        .maybeSingle()
      if (!fresh || fresh.assigned_agent_id || fresh.ai_autoreply_disabled) {
        console.info(`${tag} skipped: the thread changed hands while waiting for the burst to end`)
        return
      }
      Object.assign(conv, fresh)
    }

    const messages = await buildConversationContext(db, conversationId)
    if (messages.length === 0) {
      console.info(`${tag} skipped: no text/interactive messages to build context from`)
      return
    }

    // Deterministic "get me a person": the account listed phrases that
    // hand off before any model call — no tokens spent, no model
    // discretion (specs/ai-agents-management.md §4).
    const keyword = matchHandoffKeyword(
      lastCustomerMessage(messages) ?? '',
      config.handoffKeywords ?? [],
    )
    if (keyword) {
      console.info(`${tag} hands off: customer asked for a person (keyword match)`)
      await handOffToHuman(
        db,
        conversationId,
        config,
        conv.assigned_agent_id,
        'customer_requested_human',
        buildHandoffMeta({ messages, replyCount: conv.ai_reply_count ?? 0 }),
        noticeCtx,
      )
      return
    }

    // A bare "ok" / "👍" / "obrigado" has nothing left to be answered, and
    // every reply is paid tokens. Checked before any model call; a thank
    // you gets a canned line (no tokens), the rest gets nothing. Never
    // applies to an "ok" that answers a question or a prompt — see
    // `shouldSkipAcknowledgment`.
    {
      const heard = (lastCustomerMessage(messages) ?? '').replace(AUDIO_MARK, '').trim()
      if (classifyAcknowledgment(heard)) {
        const { data: lastBusiness } = await db
          .from('messages')
          .select('content_type, content_text')
          .eq('conversation_id', conversationId)
          .neq('sender_type', 'customer')
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle()
        const kind = shouldSkipAcknowledgment({
          text: heard,
          aiReplyCount: conv.ai_reply_count ?? 0,
          lastBusinessMessage: lastBusiness
            ? { contentType: lastBusiness.content_type, text: lastBusiness.content_text }
            : null,
        })
        if (kind) {
          console.info(`${tag} skipped: the customer only acknowledged (${kind}) — no AI call`)
          if (kind === 'thanks') {
            const reply = await loadNoticeText('AiAckNotice', 'thanks', conversationId)
            if (reply) {
              try {
                await engineSendText({
                  accountId,
                  userId: configOwnerUserId,
                  conversationId,
                  contactId,
                  text: reply,
                  aiGenerated: true,
                })
              } catch (sendErr) {
                console.error(`${tag} could not send the thanks reply:`, sendErr)
              }
            }
          }
          return
        }
      }
    }

    // Account-wide throttle on the shared BYO key. The per-conversation
    // cap bounds one thread; this bounds a burst across many threads (a
    // marketing blast landing 200 replies at once) so we never run the
    // owner's key past the provider's rate limit. Over the limit → hand
    // this thread to a human instead of dropping it: it used to `return`
    // here with no reply, no note and no notice, so a burst simply lost
    // customers.
    const acctLimit = checkRateLimit(
      `ai-autoreply:${accountId}`,
      RATE_LIMITS.aiAutoReplyAccount,
    )
    if (!acctLimit.success) {
      console.warn(
        `${tag} hands off: account ${accountId} hit the per-account rate limit`,
      )
      await handOffToHuman(
        db,
        conversationId,
        config,
        conv.assigned_agent_id,
        'rate_limited',
        buildHandoffMeta({ messages, replyCount: conv.ai_reply_count ?? 0 }),
        noticeCtx,
      )
      return
    }

    console.info(
      `${tag} generating reply — provider=${config.provider} model=${config.model} agendaEnabled=${config.agendaEnabled} fallbackTiers=${config.fallbacks.length}`,
    )
    const startedAt = Date.now()

    // Every gate has passed — we're committed to attempting a reply, so
    // show the customer "typing…" (and mark their message read) while the
    // retrieval + LLM round trips run. Meta clears the indicator after
    // 25 s or when our reply lands, whichever is first, so there's
    // nothing to undo on the handoff / no-text path. Strictly
    // best-effort: a failed indicator must never cost us the reply.
    if (inboundMessageId) {
      await showTypingIndicator(db, accountId, inboundMessageId)
    }

    // Ground the reply in the account's knowledge base (best-effort).
    const knowledge = await retrieveKnowledge(
      db,
      accountId,
      config,
      latestUserMessage(messages),
    )

    // Best-effort: a lookup failure just means the prompt treats the
    // name as unknown (the model asks for it), not a hard failure.
    const { data: contactRow } = await db
      .from('contacts')
      .select('name')
      .eq('id', contactId)
      .eq('account_id', accountId)
      .maybeSingle()

    let systemPrompt = buildSystemPrompt({
      userPrompt: config.systemPrompt,
      mode: 'auto_reply',
      knowledge,
      agendaToolsEnabled: config.agendaEnabled,
      contactName: contactRow?.name ?? null,
    })

    // Agenda tools (specs/ai-agenda-tool-calling.md) are opt-in per
    // account and auto-reply-only — draft/playground never build these,
    // since a tool call is a real side effect (a WhatsApp send, an
    // appointment write) a human hasn't approved yet. The contact-name
    // tool isn't agenda-specific, so it's always available in auto-reply.
    // Prospecting: only a conversation with an open campaign deal gets the
    // qualify tool, and the criteria go at the END of the prompt (the
    // variable part — see buildSystemPrompt's ordering note).
    const prospect = await loadProspectContext(db, conversationId)
    if (prospect) systemPrompt = `${systemPrompt}\n\n${prospectPromptLine(prospect)}`
    const baseTools = config.agendaEnabled
      ? [...CONTACT_TOOLS, ...AGENDA_TOOLS]
      : CONTACT_TOOLS
    // Human cases (specs/human-cases.md): per-agent opt-in. The open
    // cases of this thread go in the prompt so the model knows their ids.
    const openCases = config.casesEnabled ? await loadOpenCases(db, conversationId) : []
    if (config.casesEnabled) systemPrompt = `${systemPrompt}\n\n${casesPromptSection(openCases)}`
    let caseOpenedThisTurn = false
    const caseExecutor = config.casesEnabled
      ? createCaseToolExecutor({
          db,
          accountId,
          conversationId,
          contactId,
          onOpened: () => {
            caseOpenedThisTurn = true
          },
        })
      : null
    const tools = [
      ...baseTools,
      ...(prospect ? PROSPECTING_TOOLS : []),
      ...(caseExecutor ? CASE_TOOLS : []),
    ]
    const prospectExecutor = prospect
      ? createProspectingToolExecutor({ db, accountId, ctx: prospect })
      : null
    const contactExecutor = createContactToolExecutor({ db, accountId, contactId })
    const agendaExecutor = config.agendaEnabled
      ? createAgendaToolExecutor({
          db,
          accountId,
          conversationId,
          contactId,
          userId: configOwnerUserId,
        })
      : null
    const executeTool = (name: string, callArgs: Record<string, unknown>) =>
      (name === 'open_human_case' || name === 'provide_case_update') && caseExecutor
        ? caseExecutor(name, callArgs)
        : name === 'qualify_lead' && prospectExecutor
        ? prospectExecutor(name, callArgs)
        : name === 'save_contact_name'
        ? contactExecutor(name, callArgs)
        : agendaExecutor
          ? agendaExecutor(name, callArgs)
          : Promise.resolve(JSON.stringify({ error: `Unknown tool: ${name}` }))

    let generation
    try {
      generation = await generateReplyWithFallback({
        config,
        systemPrompt,
        messages,
        tools,
        executeTool,
      })
    } catch (err) {
      if (err instanceof AllProvidersFailedError) {
        // Log each tier's actual code/message/status as plain fields —
        // Vercel's log viewer renders a nested Error inside an object as
        // an opaque "[Error]" with no message, which made a real outage
        // undiagnosable from the logs alone.
        console.error(
          `${tag} generation failed after ${Date.now() - startedAt}ms: every configured tier failed —`,
          err.attempts.map((a) => ({
            provider: a.provider,
            model: a.model,
            code: a.error.code,
            status: a.error.status,
            message: a.error.message,
          })),
        )
        // Every configured tier (primary + fallbacks) failed — same
        // handoff mechanics as the content-handoff path below, just with
        // a note explaining it was a provider outage, not the model
        // choosing to bail.
        await handOffToHuman(
          db,
          conversationId,
          config,
          conv.assigned_agent_id,
          'provider_failure',
          buildHandoffMeta({
            messages,
            replyCount: conv.ai_reply_count ?? 0,
            attempts: err.attempts,
          }),
          noticeCtx,
        )
        return
      }
      console.error(
        `${tag} generation failed after ${Date.now() - startedAt}ms:`,
        err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : err,
      )
      throw err
    }

    const { text, handoff, usage } = generation
    console.info(
      `${tag} generation done in ${Date.now() - startedAt}ms — provider=${generation.provider} model=${generation.model} handoff=${handoff} textLength=${text.length} fallbackAttempts=${generation.attempts?.length ?? 0}`,
    )

    // Record token spend on the account's BYO key. Fire-and-forget so it
    // never adds latency to the customer-facing send: `logAiUsage`
    // swallows its own errors, so the floating promise can't reject.
    // Logged regardless of handoff — the provider call happened either
    // way. Logs whichever tier actually produced this result, which may
    // differ from `config.provider`/`config.model` when a fallback tier
    // was used.
    void logAiUsage(db, {
      accountId,
      conversationId,
      agentId: config.id ?? null,
      mode: 'auto_reply',
      provider: generation.provider,
      model: generation.model,
      usage,
    })

    if (handoff || !text) {
      console.info(`${tag} hands off: ${handoff ? 'model requested handoff' : 'empty reply text'}`)
      // The model can't (or shouldn't) answer — stop auto-replying on
      // this thread and hand it to a human.
      await handOffToHuman(
        db,
        conversationId,
        config,
        conv.assigned_agent_id,
        handoff ? 'model_requested' : 'empty_reply',
        buildHandoffMeta({ messages, replyCount: conv.ai_reply_count ?? 0 }),
        noticeCtx,
      )
      return
    }

    // Cases fail-safe (specs/human-cases.md §5): the reply promises the
    // team will follow up, but no case exists and none was opened this turn
    // — open one so the promise isn't empty. Only when nothing is open, so a
    // repeated promise can't pile up duplicates. Never blocks the reply.
    if (
      config.casesEnabled &&
      !caseOpenedThisTurn &&
      openCases.length === 0 &&
      promisesHumanFollowUp(text)
    ) {
      const asked = (lastCustomerMessage(messages) ?? '').trim()
      const r = await openCase(db, {
        accountId,
        conversationId,
        contactId,
        title: (asked || 'Pedido do cliente').slice(0, 120),
        summary: asked || text,
        blocker: 'A IA disse ao cliente que a equipe vai verificar, mas não abriu um caso. Confira o pedido.',
        openedBy: 'system',
      })
      if (r.ok) {
        caseOpenedThisTurn = true
        console.info(`${tag} fail-safe opened case ${r.caseId} (promise without a case)`)
      }
    }

    // Before-send guardrails, OBSERVE mode (specs/ai-output-guardrails.md):
    // record what the chain would have blocked, send regardless. Judged
    // once on the joined text, never per bubble.
    {
      const { data: gateContact } = await db
        .from('contacts')
        .select('opted_out_at')
        .eq('id', contactId)
        .maybeSingle()
      observeBeforeSend(db, {
        accountId,
        conversationId,
        text,
        // A promise of human follow-up is true when a case exists.
        ctx: {
          optedOut: !!gateContact?.opted_out_at,
          handingOff: caseOpenedThisTurn || openCases.length > 0,
        },
      })
    }

    // Atomically claim a reply slot: the cap check + increment happen in
    // one UPDATE, so concurrent inbounds can never overshoot the cap. If
    // another inbound just took the last slot, `claimed` is false and we
    // skip the send. (We consume a slot slightly before the send lands —
    // fail-safe: under-reply rather than over-reply.)
    const { data: claimed, error: claimErr } = await db.rpc(
      'claim_ai_reply_slot',
      {
        conversation_id: conversationId,
        max_replies: config.autoReplyMaxPerConversation,
      },
    )
    if (claimErr) {
      // A real error here (vs. losing the cap race) is almost always a
      // deploy issue — e.g. `claim_ai_reply_slot` not EXECUTE-able by the
      // service role, or the migration not applied. Log it loudly: a
      // silent return makes "auto-reply never fires" undiagnosable.
      console.error('[ai auto-reply] claim_ai_reply_slot failed:', claimErr)
      // Loud log AND a handoff: a deploy problem must not present to the
      // customer as "the bot ignores people".
      await handOffToHuman(
        db,
        conversationId,
        config,
        conv.assigned_agent_id,
        'system_error',
        buildHandoffMeta({ messages, replyCount: conv.ai_reply_count ?? 0 }),
        noticeCtx,
      )
      return
    }
    if (claimed !== true) {
      // Lost the per-conversation cap race: a concurrent inbound
      // claimed the last slot between our early-out read and this
      // atomic claim. Rare, but the outcome is identical to hitting
      // the cap outright — hand off rather than silently dropping the
      // reply we already generated (and already spent tokens on).
      await handOffToHuman(
        db,
        conversationId,
        config,
        conv.assigned_agent_id,
        'reply_cap',
        buildHandoffMeta({
          messages,
          replyCount: conv.ai_reply_count ?? 0,
          max: config.autoReplyMaxPerConversation,
        }),
        noticeCtx,
      )
      return
    }

    // One claimed slot covers the whole reply regardless of how many
    // bubbles it's split into — the cap bounds how many times the bot
    // answers a thread, not how many messages it takes to say it (see
    // specs/ai-humanized-multi-message-replies.md). Segments send in
    // order, each persisted as its own `messages` row (matching how
    // they actually land on WhatsApp), with a short pause + a fresh
    // "typing…" between them so a multi-part reply reads like someone
    // sending a few messages in a row rather than a wall of text.
    //
    // Every bubble is also kept under WhatsApp's 4096-character limit:
    // Meta refuses a longer body outright, so a long answer used to be
    // lost whole and the customer got nothing (a 4,402-character reply
    // from a free model, seen in production). The prompt asks for short
    // messages; this doesn't depend on the model obeying.
    // Voice reply (specs/ai-voice-replies.md, phase 2): the customer spoke,
    // the agent is set to answer in kind, and the reply is short. The text
    // above was already generated and guardrailed; any failure here falls
    // through to sending that text, never silence.
    if (
      shouldReplyInVoice({
        mode: config.voiceReplyMode,
        inboundWasAudio: !!args.audio,
        text,
      })
    ) {
      try {
        const voiceKey =
          config.provider === 'openai'
            ? config.apiKey
            : (await loadEmbeddingsKey(db, accountId)).key
        if (!voiceKey) throw new Error('no OpenAI key for speech')
        await sendVoiceReply(db, {
          accountId,
          userId: configOwnerUserId,
          conversationId,
          contactId,
          text,
          apiKey: voiceKey,
          voice: config.voiceName,
        })
        console.info(`${tag} sent a voice reply`)
        void logAiUsage(db, {
          accountId,
          conversationId,
          agentId: config.id ?? null,
          mode: 'auto_reply',
          provider: 'openai',
          model: TTS_MODEL,
          usage: null,
          kind: 'speech',
          speechChars: text.length,
        })
        return
      } catch (voiceErr) {
        console.warn(`${tag} voice reply failed, sending text instead:`, voiceErr)
      }
    }

    const segments = (generation.segments.length > 0 ? generation.segments : [text]).flatMap(
      (segment) => splitLongText(segment),
    )
    for (let i = 0; i < segments.length; i++) {
      if (i > 0) {
        await new Promise((resolve) => setTimeout(resolve, SEGMENT_DELAY_MS))
        if (inboundMessageId) {
          await showTypingIndicator(db, accountId, inboundMessageId)
        }
      }
      const sendBubble = () =>
        engineSendText({
          accountId,
          userId: configOwnerUserId,
          conversationId,
          contactId,
          text: segments[i],
          aiGenerated: true,
        })
      try {
        try {
          await sendBubble()
        } catch (firstErr) {
          // One retry before giving the thread to a person: a single
          // transient refusal from Meta (seen live: #131005 once, then the
          // next sends fine) shouldn't pause the AI and drop the reply.
          console.warn(`${tag} bubble ${i + 1} failed, retrying once:`, firstErr)
          await new Promise((resolve) => setTimeout(resolve, SEND_RETRY_DELAY_MS))
          await sendBubble()
        }
      } catch (sendErr) {
        // The reply was generated, paid for and its slot claimed, but Meta
        // refused it. Letting this fall to the outer catch left the
        // customer in silence with only a log line; hand the conversation
        // to a person instead (the customer notice goes out if it can).
        console.error(
          `${tag} sending bubble ${i + 1}/${segments.length} failed — handing off:`,
          sendErr,
        )
        await handOffToHuman(
          db,
          conversationId,
          config,
          conv.assigned_agent_id,
          'system_error',
          buildHandoffMeta({ messages, replyCount: (conv.ai_reply_count ?? 0) + 1 }),
          noticeCtx,
        )
        return
      }
    }
    console.info(`${tag} sent ${segments.length} message(s) to the customer`)
  } catch (err) {
    console.error(`[ai auto-reply ${conversationId}] dispatch failed:`, err)
  }
}

/**
 * Best-effort "typing…" for the inbound we're about to answer. Swallows
 * every failure (no WhatsApp config, bad token, Meta 4xx) with a warning
 * — the indicator is cosmetic, the reply is not.
 */
async function showTypingIndicator(
  db: ReturnType<typeof supabaseAdmin>,
  accountId: string,
  inboundMessageId: string,
): Promise<void> {
  try {
    const { phoneNumberId, accessToken } = await loadAccountMetaCredentials(
      db,
      accountId,
    )
    await sendTypingIndicator({
      phoneNumberId,
      accessToken,
      messageId: inboundMessageId,
    })
  } catch (err) {
    console.warn('[ai auto-reply] typing indicator failed (continuing):', err)
  }
}
