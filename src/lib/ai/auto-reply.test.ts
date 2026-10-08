import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AiConfig } from './types'
import { AiError } from './types'
import { AllProvidersFailedError } from './generate-with-fallback'

// Shared, hoisted mock state so the module mocks can close over it.
const h = vi.hoisted(() => ({
  loadAiConfig: vi.fn(),
  buildConversationContext: vi.fn(),
  retrieveKnowledge: vi.fn(),
  generateReplyWithFallback: vi.fn(),
  engineSendText: vi.fn(),
  loadAccountMetaCredentials: vi.fn(),
  sendTypingIndicator: vi.fn(),
  transcribeInboundAudio: vi.fn(),
  loadNoticeText: vi.fn(),
  waitForQuietPeriod: vi.fn(),
  openCase: vi.fn(),
  loadOpenCases: vi.fn(),
  loadAudioRetryText: vi.fn(),
  state: {
    /** The customer's two latest messages' transcript_status, newest first. */
    recentCustomer: [] as { transcript_status: string | null }[],
    /** The business's latest message (for the acknowledgment skip). */
    lastBusiness: null as { content_type: string; content_text: string } | null,
    conv: null as Record<string, unknown> | null,
    autoResponders: [] as { id: string }[],
    claim: true as boolean,
    /** The first conversations UPDATE — the handoff write itself. */
    updatePayload: null as Record<string, unknown> | null,
    /** Every conversations UPDATE, in order (handoff, notice claim, outcome). */
    updates: [] as Record<string, unknown>[],
    /** Does the "notice not yet sent" claim win? */
    noticeClaim: true as boolean,
    claimError: null as { message: string } | null,
    rateLimited: false as boolean,
    /** ai_channel_agents lookup result: the agent bound to this number. */
    boundAgentId: null as string | null,
    rpcCalls: [] as { name: string; args: unknown }[],
    contact: null as { name: string | null } | null,
  },
}))

vi.mock('./config', () => ({ loadAiConfig: h.loadAiConfig }))
vi.mock('./audio-inbound', () => ({
  transcribeInboundAudio: h.transcribeInboundAudio,
  loadAudioRetryText: h.loadAudioRetryText,
}))
vi.mock('./context', () => ({
  buildConversationContext: h.buildConversationContext,
  AUDIO_MARK: '[áudio transcrito]',
}))
vi.mock('./notice-text', () => ({ loadNoticeText: h.loadNoticeText }))
// The STOP confirmation (migration 101) sends through the same engine;
// its DB claim is covered where it lives, not in this fake.
vi.mock('@/lib/contacts/opt-out-confirm', async () => {
  const notice = await vi.importActual<typeof import('./handoff-notice')>('./handoff-notice')
  return {
    confirmOptOut: async (_db: unknown, a: { conversationId: string }) => {
      const text = notice.handoffNoticeText({
        optOut: true,
        teamOnline: false,
        leadKey: a.conversationId,
        dict: await notice.loadHandoffNoticeDict(),
      })
      await h.engineSendText({ text })
      return 'sent'
    },
  }
})
vi.mock('./burst', () => ({ waitForQuietPeriod: h.waitForQuietPeriod }))
vi.mock('@/lib/cases/store', () => ({ openCase: h.openCase }))
vi.mock('./tools/cases', () => ({
  CASE_TOOLS: [],
  casesPromptSection: () => 'cases',
  createCaseToolExecutor: () => async () => '{}',
  loadOpenCases: h.loadOpenCases,
}))
vi.mock('./knowledge', () => ({ retrieveKnowledge: h.retrieveKnowledge }))
// `AllProvidersFailedError` is imported by auto-reply.ts alongside the
// mocked function — re-export the real class so `instanceof` checks in
// the code under test still work against errors the mock throws.
vi.mock('./generate-with-fallback', async () => {
  const actual = await vi.importActual<typeof import('./generate-with-fallback')>(
    './generate-with-fallback',
  )
  return {
    ...actual,
    generateReplyWithFallback: h.generateReplyWithFallback,
  }
})
vi.mock('@/lib/flows/meta-send', () => ({
  engineSendText: h.engineSendText,
  loadAccountMetaCredentials: h.loadAccountMetaCredentials,
}))
vi.mock('@/lib/rate-limit', async () => {
  const actual = await vi.importActual<typeof import('@/lib/rate-limit')>(
    '@/lib/rate-limit',
  )
  return {
    ...actual,
    // Never the real in-memory counter: it accumulates across every
    // dispatch in this file and would start tripping mid-suite. Tests that
    // care flip `state.rateLimited`.
    checkRateLimit: () =>
      h.state.rateLimited
        ? { success: false, remaining: 0, resetAt: Date.now() + 1000 }
        : { success: true, remaining: 99, resetAt: Date.now() + 60_000 },
  }
})
vi.mock('@/lib/whatsapp/meta-api', () => ({
  sendTypingIndicator: h.sendTypingIndicator,
}))
vi.mock('./admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      if (table === 'automations') {
        // .select().eq().eq().in().limit() → active auto-responders
        const chain = {
          select: () => chain,
          eq: () => chain,
          in: () => chain,
          limit: () =>
            Promise.resolve({ data: h.state.autoResponders, error: null }),
        }
        return chain
      }
      if (table === 'ai_channel_agents') {
        // .select().eq().is()|eq().maybeSingle() → the bound agent, if any
        const chain = {
          select: () => chain,
          eq: () => chain,
          is: () => chain,
          maybeSingle: () =>
            Promise.resolve({
              data: h.state.boundAgentId ? { agent_id: h.state.boundAgentId } : null,
              error: null,
            }),
        }
        return chain
      }
      if (table === 'messages') {
        // .select().eq().eq().order().limit() → the customer's latest messages
        const chain = {
          select: () => chain,
          eq: () => chain,
          neq: () => chain,
          order: () => chain,
          limit: () => Object.assign(Promise.resolve({ data: h.state.recentCustomer, error: null }), chain),
          maybeSingle: () => Promise.resolve({ data: h.state.lastBusiness, error: null }),
        }
        return chain
      }
      if (table === 'contacts') {
        // .select().eq().eq().maybeSingle() → the contact's known name
        const chain = {
          select: () => chain,
          eq: () => chain,
          maybeSingle: () =>
            Promise.resolve({ data: h.state.contact, error: null }),
        }
        return chain
      }
      // conversations
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: () =>
              Promise.resolve({ data: h.state.conv, error: null }),
          }),
        }),
        update: (payload: Record<string, unknown>) => {
          h.state.updates.push(payload)
          if (h.state.updatePayload === null) h.state.updatePayload = payload
          // Awaitable after .eq() (plain writes) and chainable through
          // .is().select() (the "claim the notice" write).
          const chain: Record<string, unknown> = {
            eq: () => chain,
            is: () => ({
              select: () =>
                Promise.resolve({
                  data: h.state.noticeClaim ? [{ id: 'conv-1' }] : [],
                  error: null,
                }),
            }),
            then: (resolve: (v: unknown) => unknown) =>
              Promise.resolve({ error: null }).then(resolve),
          }
          return chain
        },
      }
    },
    rpc: (name: string, args: unknown) => {
      h.state.rpcCalls.push({ name, args })
      return Promise.resolve(
        h.state.claimError
          ? { data: null, error: h.state.claimError }
          : { data: h.state.claim, error: null },
      )
    },
  }),
}))

import { dispatchInboundToAiReply, dropEchoedPrompts } from './auto-reply'

const ARGS = {
  accountId: 'acct-1',
  conversationId: 'conv-1',
  contactId: 'contact-1',
  configOwnerUserId: 'user-1',
  inboundMessageId: 'wamid.inbound-1',
}

function aiConfig(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    provider: 'openai',
    model: 'gpt-test',
    apiKey: 'sk-test',
    systemPrompt: null,
    isActive: true,
    autoReplyEnabled: true,
    autoReplyMaxPerConversation: 3,
    handoffAgentId: null,
    embeddingsApiKey: null,
    fallbacks: [],
    agendaEnabled: false,
    ...overrides,
  }
}

beforeEach(() => {
  h.state.conv = {
    assigned_agent_id: null,
    ai_autoreply_disabled: false,
    ai_reply_count: 0,
  }
  h.state.autoResponders = []
  h.state.claim = true
  h.state.updatePayload = null
  h.state.updates = []
  h.state.noticeClaim = true
  h.state.claimError = null
  h.state.rateLimited = false
  h.state.boundAgentId = null
  h.state.rpcCalls = []
  h.state.contact = null
  h.state.recentCustomer = []
  h.state.lastBusiness = null
  h.loadNoticeText.mockReset()
  h.waitForQuietPeriod.mockReset()
  h.waitForQuietPeriod.mockResolvedValue('proceed')
  h.openCase.mockReset()
  h.openCase.mockResolvedValue({ ok: true, caseId: 'case-x' })
  h.loadOpenCases.mockReset()
  h.loadOpenCases.mockResolvedValue([])
  h.transcribeInboundAudio.mockReset()
  h.loadAudioRetryText.mockReset()
  h.loadAiConfig.mockResolvedValue(aiConfig())
  h.buildConversationContext.mockResolvedValue([{ role: 'user', content: 'hi' }])
  h.retrieveKnowledge.mockResolvedValue([])
  h.generateReplyWithFallback.mockResolvedValue({
    text: 'Hello!',
    segments: ['Hello!'],
    handoff: false,
    usage: null,
    provider: 'openai',
    model: 'gpt-test',
    attempts: [],
  })
  h.engineSendText.mockResolvedValue({ whatsapp_message_id: 'm1' })
  h.loadAccountMetaCredentials.mockResolvedValue({
    phoneNumberId: 'pn-1',
    accessToken: 'tok',
  })
  h.sendTypingIndicator.mockResolvedValue(undefined)
})

describe('dispatchInboundToAiReply — eligibility gates', () => {
  it('claims a slot and sends on the happy path', async () => {
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.rpcCalls).toEqual([
      {
        name: 'claim_ai_reply_slot',
        args: { conversation_id: 'conv-1', max_replies: 3 },
      },
    ])
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1', text: 'Hello!' }),
    )
  })

  it('grounds the reply in retrieved knowledge', async () => {
    h.retrieveKnowledge.mockResolvedValue(['Returns accepted within 30 days.'])
    await dispatchInboundToAiReply(ARGS)
    expect(h.retrieveKnowledge).toHaveBeenCalled()
    const systemPrompt = h.generateReplyWithFallback.mock.calls[0][0].systemPrompt as string
    expect(systemPrompt).toContain('Returns accepted within 30 days.')
  })

  it('teaches the model to ask for the customer name when unknown', async () => {
    h.state.contact = { name: null }
    await dispatchInboundToAiReply(ARGS)
    const call = h.generateReplyWithFallback.mock.calls[0][0]
    expect(call.systemPrompt).toContain("don't know this customer's name yet")
    expect(call.tools).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'save_contact_name' })]),
    )
  })

  it('tells the model the known customer name instead of asking again', async () => {
    h.state.contact = { name: 'Maria' }
    await dispatchInboundToAiReply(ARGS)
    const systemPrompt = h.generateReplyWithFallback.mock.calls[0][0].systemPrompt as string
    expect(systemPrompt).toContain('"Maria"')
    expect(systemPrompt).not.toContain("don't know this customer's name")
  })

  it('stands down when an active message-level automation exists', async () => {
    h.state.autoResponders = [{ id: 'auto-1' }]
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReplyWithFallback).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.sendTypingIndicator).not.toHaveBeenCalled()
  })

  it('hands off to a human when the atomic slot claim loses the race', async () => {
    h.state.claim = false
    await dispatchInboundToAiReply(ARGS)
    // It still attempts the claim, but the send is skipped and the
    // conversation is handed off rather than silently dropped — the
    // reply was already generated (and paid for) at this point.
    expect(h.state.rpcCalls).toHaveLength(1)
    // The AI's own reply is never sent — only the handoff notice is.
    expect(h.engineSendText).toHaveBeenCalledTimes(1)
    expect(h.engineSendText.mock.calls[0][0].text).not.toBe('Hello!')
    expect(h.state.updatePayload).toMatchObject({
      ai_autoreply_disabled: true,
      ai_handoff_reason: 'reply_cap',
    })
  })

  it('skips when AI is off / not configured', async () => {
    h.loadAiConfig.mockResolvedValue(null)
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReplyWithFallback).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when auto-reply is disabled for the account', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ autoReplyEnabled: false }))
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when a human agent is assigned', async () => {
    h.state.conv = {
      assigned_agent_id: 'agent-9',
      ai_autoreply_disabled: false,
      ai_reply_count: 0,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.sendTypingIndicator).not.toHaveBeenCalled()
  })

  it('skips when auto-reply was disabled on this conversation', async () => {
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: true,
      ai_reply_count: 0,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('hands off to a human when the per-conversation cap is reached (#reply-cap-handoff)', async () => {
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: false,
      ai_reply_count: 3,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReplyWithFallback).not.toHaveBeenCalled()
    // Reaching the cap must not go silent — the settings copy promises
    // a handoff here, and previously this path just returned with no
    // notification, silently stranding the conversation. The customer
    // now hears about it too (one notice, no AI reply).
    expect(h.engineSendText).toHaveBeenCalledTimes(1)
    expect(h.state.updatePayload).toMatchObject({
      ai_autoreply_disabled: true,
      ai_handoff_reason: 'reply_cap',
      ai_handoff_meta: { replyCount: 3, max: 3 },
      ai_handoff_summary: null,
    })
  })

  it('routes the reply-cap handoff to the configured agent', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ handoffAgentId: 'agent-7' }))
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: false,
      ai_reply_count: 3,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.updatePayload).toMatchObject({
      ai_autoreply_disabled: true,
      assigned_agent_id: 'agent-7',
    })
  })

  it('skips when there is nothing to reply to', async () => {
    h.buildConversationContext.mockResolvedValue([])
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReplyWithFallback).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.sendTypingIndicator).not.toHaveBeenCalled()
  })
})

describe('dispatchInboundToAiReply — typing indicator (#527)', () => {
  it('shows "typing…" on the inbound wamid before calling the LLM', async () => {
    await dispatchInboundToAiReply(ARGS)
    // Third arg: the conversation, whose official number is used.
    expect(h.loadAccountMetaCredentials).toHaveBeenCalledWith(
      expect.anything(),
      'acct-1',
      expect.any(String),
    )
    expect(h.sendTypingIndicator).toHaveBeenCalledTimes(1)
    expect(h.sendTypingIndicator).toHaveBeenCalledWith({
      phoneNumberId: 'pn-1',
      accessToken: 'tok',
      messageId: 'wamid.inbound-1',
    })
    // Ordering: the indicator goes out while the customer waits on the
    // model, not after the reply is already generated.
    const typingOrder = h.sendTypingIndicator.mock.invocationCallOrder[0]
    const llmOrder = h.generateReplyWithFallback.mock.invocationCallOrder[0]
    expect(typingOrder).toBeLessThan(llmOrder)
    expect(h.engineSendText).toHaveBeenCalledTimes(1)
  })

  it('still sends the reply when the indicator request fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    h.sendTypingIndicator.mockRejectedValue(new Error('Meta API error: 400'))
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReplyWithFallback).toHaveBeenCalledTimes(1)
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1', text: 'Hello!' }),
    )
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('typing indicator failed'),
      expect.any(Error),
    )
    warn.mockRestore()
  })

  it('still sends the reply when the WhatsApp credentials cannot be loaded', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    h.loadAccountMetaCredentials.mockRejectedValue(
      new Error('WhatsApp not configured for this account'),
    )
    await dispatchInboundToAiReply(ARGS)
    expect(h.sendTypingIndicator).not.toHaveBeenCalled()
    expect(h.engineSendText).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('skips the indicator when no inbound wamid is supplied', async () => {
    const { inboundMessageId: _omit, ...legacyArgs } = ARGS
    void _omit
    await dispatchInboundToAiReply(legacyArgs)
    expect(h.sendTypingIndicator).not.toHaveBeenCalled()
    expect(h.loadAccountMetaCredentials).not.toHaveBeenCalled()
    expect(h.engineSendText).toHaveBeenCalledTimes(1)
  })

  it('does not fire when a gate short-circuits before the LLM', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ autoReplyEnabled: false }))
    await dispatchInboundToAiReply(ARGS)
    expect(h.sendTypingIndicator).not.toHaveBeenCalled()
    expect(h.loadAccountMetaCredentials).not.toHaveBeenCalled()
  })
})

describe('dispatchInboundToAiReply — handoff', () => {
  it('disables auto-reply and records the reason instead of an English sentence', async () => {
    h.generateReplyWithFallback.mockResolvedValue({ text: '', handoff: true })
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.rpcCalls).toHaveLength(0)
    expect(h.state.updatePayload).toMatchObject({
      ai_autoreply_disabled: true,
      ai_handoff_reason: 'model_requested',
      ai_handoff_meta: { replyCount: 0, lastCustomerMessage: 'hi' },
      ai_handoff_summary: null,
    })
    // No handoff target configured → conversation left unassigned.
    expect(h.state.updatePayload).not.toHaveProperty('assigned_agent_id')
  })

  it('routes to the configured handoff agent on handoff', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ handoffAgentId: 'agent-7' }))
    h.generateReplyWithFallback.mockResolvedValue({ text: '', handoff: true })
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.updatePayload).toMatchObject({
      ai_autoreply_disabled: true,
      assigned_agent_id: 'agent-7',
    })
  })
})

describe('dispatchInboundToAiReply — customer notice on handoff (specs/handoff-customer-notice.md)', () => {
  const handOff = () =>
    h.generateReplyWithFallback.mockResolvedValue({ text: '', handoff: true })

  it('sends the customer exactly one AI-flagged notice, after the handoff is written', async () => {
    handOff()
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).toHaveBeenCalledTimes(1)
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: 'acct-1',
        conversationId: 'conv-1',
        contactId: 'contact-1',
        aiGenerated: true,
      }),
    )
    expect(h.engineSendText.mock.calls[0][0].text).toEqual(expect.any(String))
    // handoff first, then claim the notice, then record the outcome
    expect(h.state.updates[0]).toMatchObject({ ai_autoreply_disabled: true })
    expect(h.state.updates[1]).toEqual({ ai_handoff_customer_notified: false })
    expect(h.state.updates[2]).toEqual({
      ai_handoff_customer_notified: true,
      ai_handoff_notice_skipped_reason: null,
    })
  })

  it('does not send a second notice when another handoff already claimed it', async () => {
    handOff()
    h.state.noticeClaim = false
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.updatePayload).toMatchObject({ ai_autoreply_disabled: true })
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('keeps the conversation handed off and records why when the send fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    handOff()
    h.engineSendText.mockRejectedValue(new Error('Meta API error: 131047'))
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.updatePayload).toMatchObject({
      ai_autoreply_disabled: true,
      ai_handoff_reason: 'model_requested',
    })
    expect(h.state.updates.at(-1)).toEqual({
      ai_handoff_notice_skipped_reason: 'send_failed',
    })
    warn.mockRestore()
  })

  it('stays quiet toward a contact who opted out earlier', async () => {
    handOff()
    h.state.contact = { name: null, opted_out_at: '2026-09-01T00:00:00Z' } as never
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.state.updates.at(-1)).toEqual({
      ai_handoff_notice_skipped_reason: 'opted_out',
    })
  })

  it('confirms the opt-out to a customer whose message was the opt-out', async () => {
    handOff()
    h.buildConversationContext.mockResolvedValue([
      { role: 'user', content: 'parar' },
    ])
    h.state.contact = { name: null, opted_out_at: '2026-09-29T00:00:00Z' } as never
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).toHaveBeenCalledTimes(1)
    // The opt-out copy never says a person is coming.
    expect(h.engineSendText.mock.calls[0][0].text).not.toMatch(/team|equipe|equipo/i)
  })

  it('hands off — instead of silently dropping — when the account rate limit trips', async () => {
    h.state.rateLimited = true
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReplyWithFallback).not.toHaveBeenCalled()
    expect(h.state.updatePayload).toMatchObject({
      ai_autoreply_disabled: true,
      ai_handoff_reason: 'rate_limited',
    })
    expect(h.engineSendText).toHaveBeenCalledTimes(1)
  })

  it('hands off when reserving the reply slot errors, keeping the loud log', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    h.state.claimError = { message: 'permission denied for function' }
    await dispatchInboundToAiReply(ARGS)
    expect(errorSpy).toHaveBeenCalledWith(
      '[ai auto-reply] claim_ai_reply_slot failed:',
      expect.anything(),
    )
    expect(h.state.updatePayload).toMatchObject({
      ai_autoreply_disabled: true,
      ai_handoff_reason: 'system_error',
    })
    // The generated reply is not sent; only the notice is.
    expect(h.engineSendText).toHaveBeenCalledTimes(1)
    expect(h.engineSendText.mock.calls[0][0].text).not.toBe('Hello!')
    errorSpy.mockRestore()
  })

  it('does not notify a customer whose thread a human already owns', async () => {
    // The dispatch gate stands down for assigned threads, so this only
    // matters for the helper's own guard — assert via the public path:
    // no handoff, no notice.
    h.state.conv = { assigned_agent_id: 'agent-9', ai_autoreply_disabled: false, ai_reply_count: 0 }
    handOff()
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })
})

describe('dispatchInboundToAiReply — agent per number (specs/ai-agents-management.md)', () => {
  const DEFAULT = aiConfig({ id: 'agent-default', model: 'default-model' })
  const BOUND = aiConfig({ id: 'agent-barber', model: 'barber-model' })

  beforeEach(() => {
    h.loadAiConfig.mockImplementation(
      async (_db: unknown, _acct: string, opts?: { agentId?: string }) =>
        opts?.agentId === 'agent-barber' ? BOUND : DEFAULT,
    )
  })

  it('answers with the agent bound to the number instead of the default', async () => {
    h.state.boundAgentId = 'agent-barber'
    await dispatchInboundToAiReply(ARGS)
    expect(h.loadAiConfig).toHaveBeenCalledWith(expect.anything(), 'acct-1', {
      agentId: 'agent-barber',
    })
    expect(h.generateReplyWithFallback.mock.calls[0][0].config.model).toBe('barber-model')
  })

  it('answers with the bound agent even when the default agent is off', async () => {
    h.state.boundAgentId = 'agent-barber'
    h.loadAiConfig.mockImplementation(
      async (_db: unknown, _acct: string, opts?: { agentId?: string }) =>
        opts?.agentId === 'agent-barber' ? BOUND : null,
    )
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReplyWithFallback.mock.calls[0][0].config.model).toBe('barber-model')
  })

  it('stays silent when the default is off and nothing is bound', async () => {
    h.loadAiConfig.mockResolvedValue(null)
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReplyWithFallback).not.toHaveBeenCalled()
  })

  it('uses the default agent when the number has no binding', async () => {
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReplyWithFallback.mock.calls[0][0].config.model).toBe('default-model')
  })

  it('does not reload when the binding IS the default agent', async () => {
    h.state.boundAgentId = 'agent-default'
    await dispatchInboundToAiReply(ARGS)
    expect(h.loadAiConfig).toHaveBeenCalledTimes(1)
    expect(h.generateReplyWithFallback.mock.calls[0][0].config.model).toBe('default-model')
  })

  it('stays silent — never falls back to another client’s agent — when the bound agent is unavailable', async () => {
    h.state.boundAgentId = 'agent-barber'
    h.loadAiConfig.mockImplementation(
      async (_db: unknown, _acct: string, opts?: { agentId?: string }) =>
        opts?.agentId ? null : DEFAULT,
    )
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReplyWithFallback).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('stays silent when the bound agent has auto-reply switched off', async () => {
    h.state.boundAgentId = 'agent-barber'
    h.loadAiConfig.mockImplementation(
      async (_db: unknown, _acct: string, opts?: { agentId?: string }) =>
        opts?.agentId ? { ...BOUND, autoReplyEnabled: false } : DEFAULT,
    )
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReplyWithFallback).not.toHaveBeenCalled()
  })

  it('stays silent when the bound agent cannot be loaded (e.g. undecryptable key)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    h.state.boundAgentId = 'agent-barber'
    h.loadAiConfig.mockImplementation(
      async (_db: unknown, _acct: string, opts?: { agentId?: string }) => {
        if (opts?.agentId) throw new Error('decrypt failed')
        return DEFAULT
      },
    )
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReplyWithFallback).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('dispatchInboundToAiReply — deterministic handoff keywords', () => {
  it('hands off before any model call when the customer asks for a person', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ handoffKeywords: ['atendente'] }))
    h.buildConversationContext.mockResolvedValue([
      { role: 'user', content: 'Quero falar com um ATENDENTE, por favor' },
    ])
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReplyWithFallback).not.toHaveBeenCalled() // no tokens spent
    expect(h.state.updatePayload).toMatchObject({
      ai_autoreply_disabled: true,
      ai_handoff_reason: 'customer_requested_human',
    })
    // ...and the customer is told, as with every handoff.
    expect(h.engineSendText).toHaveBeenCalledTimes(1)
  })

  it('does nothing special when no keywords are configured', async () => {
    h.buildConversationContext.mockResolvedValue([
      { role: 'user', content: 'quero um atendente' },
    ])
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReplyWithFallback).toHaveBeenCalledTimes(1)
  })

  it('ignores a keyword that only appears inside a longer word', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ handoffKeywords: ['atendente'] }))
    h.buildConversationContext.mockResolvedValue([
      { role: 'user', content: 'os atendentes-modelo daí são ótimos' },
    ])
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReplyWithFallback).toHaveBeenCalledTimes(1)
  })
})

describe('dispatchInboundToAiReply — bursts', () => {
  it('a superseded dispatch makes no AI call and sends nothing', async () => {
    h.waitForQuietPeriod.mockResolvedValue('superseded')
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReplyWithFallback).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.state.updatePayload).toBeNull()
  })

  it('the surviving dispatch answers once', async () => {
    await dispatchInboundToAiReply(ARGS)
    expect(h.waitForQuietPeriod).toHaveBeenCalledTimes(1)
    expect(h.generateReplyWithFallback).toHaveBeenCalledTimes(1)
  })

  it('a button/list tap answers immediately, without waiting', async () => {
    await dispatchInboundToAiReply({ ...ARGS, immediate: true })
    expect(h.waitForQuietPeriod).not.toHaveBeenCalled()
    expect(h.generateReplyWithFallback).toHaveBeenCalledTimes(1)
  })

  it('stands down if a person took the thread while it waited', async () => {
    // The conversation read after the wait shows a human assigned.
    let reads = 0
    h.waitForQuietPeriod.mockImplementation(async () => {
      reads++
      h.state.conv = { assigned_agent_id: 'agent-9', ai_autoreply_disabled: false, ai_reply_count: 0 }
      return 'proceed'
    })
    await dispatchInboundToAiReply(ARGS)
    expect(reads).toBe(1)
    expect(h.generateReplyWithFallback).not.toHaveBeenCalled()
  })
})

describe('dispatchInboundToAiReply — acknowledgments', () => {
  const asks = (text: string, aiReplyCount = 2) => {
    h.state.conv = { assigned_agent_id: null, ai_autoreply_disabled: false, ai_reply_count: aiReplyCount }
    h.buildConversationContext.mockResolvedValue([{ role: 'user', content: text }])
  }

  it('an "ok" after a statement costs no AI call and sends nothing', async () => {
    asks('ok')
    h.state.lastBusiness = { content_type: 'text', content_text: 'Pedido registrado.' }
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReplyWithFallback).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.state.updatePayload).toBeNull()
  })

  it('a thank you gets the canned line, still no AI call', async () => {
    asks('obrigado!')
    h.state.lastBusiness = { content_type: 'text', content_text: 'Pedido registrado.' }
    h.loadNoticeText.mockResolvedValue('De nada!')
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReplyWithFallback).not.toHaveBeenCalled()
    expect(h.engineSendText).toHaveBeenCalledTimes(1)
    expect(h.engineSendText.mock.calls[0][0].text).toBe('De nada!')
  })

  it('an "ok" that answers a question IS answered', async () => {
    asks('ok')
    h.state.lastBusiness = { content_type: 'text', content_text: 'Confirma às 15h?' }
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReplyWithFallback).toHaveBeenCalledTimes(1)
  })

  it('the first message of a conversation is answered even if it is "ok"', async () => {
    asks('ok', 0)
    h.state.lastBusiness = { content_type: 'text', content_text: 'Olá' }
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReplyWithFallback).toHaveBeenCalledTimes(1)
  })
})

describe('dispatchInboundToAiReply — voice notes', () => {
  const AUDIO = { messageRowId: 'row-1', mediaId: 'media-1', accessToken: 'tok' }

  it('a transcribed voice note is answered like text', async () => {
    h.transcribeInboundAudio.mockResolvedValue({ status: 'done', transcript: 'quero agendar' })
    await dispatchInboundToAiReply({ ...ARGS, audio: AUDIO })
    expect(h.transcribeInboundAudio).toHaveBeenCalledTimes(1)
    expect(h.generateReplyWithFallback).toHaveBeenCalledTimes(1)
  })

  it('first unreadable audio: asks for text, no handoff, no model call', async () => {
    h.transcribeInboundAudio.mockResolvedValue({ status: 'failed', reason: 'transcribe' })
    h.loadAudioRetryText.mockResolvedValue('Pode escrever?')
    h.state.recentCustomer = [{ transcript_status: 'failed' }]
    await dispatchInboundToAiReply({ ...ARGS, audio: AUDIO })
    expect(h.engineSendText).toHaveBeenCalledTimes(1)
    expect(h.engineSendText.mock.calls[0][0].text).toBe('Pode escrever?')
    expect(h.generateReplyWithFallback).not.toHaveBeenCalled()
    expect(h.state.updatePayload).toBeNull()
  })

  it('second unreadable audio in a row: hands off instead of asking again', async () => {
    h.transcribeInboundAudio.mockResolvedValue({ status: 'failed', reason: 'transcribe' })
    h.loadAudioRetryText.mockResolvedValue('Pode escrever?')
    h.state.recentCustomer = [{ transcript_status: 'failed' }, { transcript_status: 'failed' }]
    await dispatchInboundToAiReply({ ...ARGS, audio: AUDIO })
    expect(h.state.updatePayload).toMatchObject({ ai_handoff_reason: 'audio_unintelligible' })
    expect(h.generateReplyWithFallback).not.toHaveBeenCalled()
  })

  it('does not transcribe (or pay) when a human owns the thread', async () => {
    h.state.conv = { assigned_agent_id: 'agent-1', ai_autoreply_disabled: false, ai_reply_count: 0 }
    await dispatchInboundToAiReply({ ...ARGS, audio: AUDIO })
    expect(h.transcribeInboundAudio).not.toHaveBeenCalled()
  })
})

describe('dispatchInboundToAiReply — long replies and failed sends', () => {
  const longText = `${'Esta é uma frase de exemplo com bastante conteúdo. '.repeat(90).trim()}`

  it('splits a reply over the WhatsApp limit into several messages (the 4,402-char production case)', async () => {
    expect(longText.length).toBeGreaterThan(4096)
    h.generateReplyWithFallback.mockResolvedValue({
      text: longText,
      segments: [longText],
      handoff: false,
      usage: null,
      provider: 'openai',
      model: 'gpt-test',
      attempts: [],
    })
    vi.useFakeTimers()
    const run = dispatchInboundToAiReply(ARGS)
    await vi.runAllTimersAsync()
    await run
    vi.useRealTimers()

    expect(h.engineSendText.mock.calls.length).toBeGreaterThan(1)
    for (const [call] of h.engineSendText.mock.calls) {
      expect(call.text.length).toBeLessThanOrEqual(4000)
    }
    const rejoined = h.engineSendText.mock.calls.map(([c]) => c.text).join(' ')
    expect(rejoined.split(/\s+/).filter(Boolean)).toEqual(
      longText.split(/\s+/).filter(Boolean),
    )
  })

  it('hands off — instead of staying silent — when Meta refuses the send', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const refused = new Error('Param text.body must be at most 4096 characters long.')
    h.engineSendText
      .mockRejectedValueOnce(refused) // the bubble
      .mockRejectedValueOnce(refused) // its one retry
      .mockResolvedValue({ whatsapp_message_id: 'm-notice' })
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.updatePayload).toMatchObject({
      ai_autoreply_disabled: true,
      ai_handoff_reason: 'system_error',
    })
    // bubble, retry, then the customer notice
    expect(h.engineSendText).toHaveBeenCalledTimes(3)
    errorSpy.mockRestore()
    warnSpy.mockRestore()
  })

  it('retries a bubble once and keeps the AI on when the retry goes through', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    h.engineSendText
      .mockRejectedValueOnce(new Error('(#131005) Access denied'))
      .mockResolvedValue({ whatsapp_message_id: 'm-ok' })
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).toHaveBeenCalledTimes(2)
    expect(h.state.updatePayload?.ai_autoreply_disabled).not.toBe(true)
    warnSpy.mockRestore()
  })
})

describe('dispatchInboundToAiReply — provider fallback exhaustion (#specs/ai-provider-fallback-chain)', () => {
  it('hands off to a human when every configured provider tier fails', async () => {
    const attempts = [
      { provider: 'openai', model: 'gpt-test', error: new AiError('boom', { code: 'provider_error' }) },
    ]
    h.generateReplyWithFallback.mockRejectedValue(new AllProvidersFailedError(attempts))
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.updatePayload).toMatchObject({
      ai_autoreply_disabled: true,
      ai_handoff_reason: 'provider_failure',
      ai_handoff_meta: {
        attempts: [{ provider: 'openai', code: 'provider_error' }],
      },
    })
    // The customer is told even though no provider could answer.
    expect(h.engineSendText).toHaveBeenCalledTimes(1)
    // No handoff target configured → conversation left unassigned.
    expect(h.state.updatePayload).not.toHaveProperty('assigned_agent_id')
  })

  it('routes the provider-failure handoff to the configured agent', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ handoffAgentId: 'agent-7' }))
    h.generateReplyWithFallback.mockRejectedValue(
      new AllProvidersFailedError([
        { provider: 'openai', model: 'gpt-test', error: new AiError('boom', { code: 'timeout' }) },
      ]),
    )
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.updatePayload).toMatchObject({
      ai_autoreply_disabled: true,
      assigned_agent_id: 'agent-7',
    })
  })

  it('does not swallow an unexpected (non-fallback) error', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    h.generateReplyWithFallback.mockRejectedValue(new Error('unexpected'))
    // The outer try/catch in dispatchInboundToAiReply still catches this
    // — it must never throw into the webhook handler — but it should
    // NOT take the provider-failure handoff path for an error that
    // isn't AllProvidersFailedError.
    await expect(dispatchInboundToAiReply(ARGS)).resolves.toBeUndefined()
    expect(h.state.updatePayload).toBeNull()
    errorSpy.mockRestore()
  })
})

describe('dispatchInboundToAiReply — multi-message replies (specs/ai-humanized-multi-message-replies)', () => {
  it('sends each segment as its own message, in order', async () => {
    h.generateReplyWithFallback.mockResolvedValue({
      text: 'First part\n\nSecond part',
      segments: ['First part', 'Second part'],
      handoff: false,
      usage: null,
      provider: 'openai',
      model: 'gpt-test',
      attempts: [],
    })
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).toHaveBeenCalledTimes(2)
    expect(h.engineSendText).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ text: 'First part' }),
    )
    expect(h.engineSendText).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ text: 'Second part' }),
    )
  })

  it('claims exactly one reply slot regardless of segment count', async () => {
    h.generateReplyWithFallback.mockResolvedValue({
      text: 'a\n\nb\n\nc',
      segments: ['a', 'b', 'c'],
      handoff: false,
      usage: null,
      provider: 'openai',
      model: 'gpt-test',
      attempts: [],
    })
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.rpcCalls).toHaveLength(1)
    expect(h.engineSendText).toHaveBeenCalledTimes(3)
  })

  it('shows a fresh typing indicator between segments, not before the first', async () => {
    h.generateReplyWithFallback.mockResolvedValue({
      text: 'a\n\nb',
      segments: ['a', 'b'],
      handoff: false,
      usage: null,
      provider: 'openai',
      model: 'gpt-test',
      attempts: [],
    })
    await dispatchInboundToAiReply(ARGS)
    // Once before generation starts (existing behaviour) + once between
    // the two segments.
    expect(h.sendTypingIndicator).toHaveBeenCalledTimes(2)
  })

  it('falls back to a single send when segments is empty but text is not', async () => {
    // Defensive: a provider mock (or an older code path) that returns
    // no segments shouldn't drop the reply — fall back to sending
    // `text` as one message.
    h.generateReplyWithFallback.mockResolvedValue({
      text: 'Hello!',
      segments: [],
      handoff: false,
      usage: null,
      provider: 'openai',
      model: 'gpt-test',
      attempts: [],
    })
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).toHaveBeenCalledTimes(1)
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Hello!' }),
    )
  })
})

describe('dispatchInboundToAiReply — agent pinned by a prospecting campaign', () => {
  it('answers with the pinned agent', async () => {
    h.state.conv = { assigned_agent_id: null, ai_autoreply_disabled: false, ai_reply_count: 0, pinned_ai_agent_id: 'agent-p' }
    h.loadAiConfig.mockImplementation(async (_db: unknown, _acc: string, opts?: { agentId?: string }) =>
      aiConfig({ id: opts?.agentId ?? 'default', model: opts?.agentId ? 'pinned-model' : 'gpt-test' }),
    )
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReplyWithFallback.mock.calls[0][0].config.model).toBe('pinned-model')
  })

  it('stays silent when the pinned agent is off', async () => {
    h.state.conv = { assigned_agent_id: null, ai_autoreply_disabled: false, ai_reply_count: 0, pinned_ai_agent_id: 'agent-p' }
    h.loadAiConfig.mockImplementation(async (_db: unknown, _acc: string, opts?: { agentId?: string }) =>
      opts?.agentId ? aiConfig({ id: 'agent-p', autoReplyEnabled: false }) : aiConfig({ id: 'default' }),
    )
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReplyWithFallback).not.toHaveBeenCalled()
  })
})

describe('dispatchInboundToAiReply — human cases fail-safe', () => {
  const promise = 'Vou verificar com a equipe e te retorno.'
  const reply = (text: string) =>
    h.generateReplyWithFallback.mockResolvedValue({
      text,
      segments: [text],
      handoff: false,
      usage: null,
      provider: 'openai',
      model: 'gpt-test',
      attempts: [],
    })

  it('a promise with no case opens one (system), and the reply still goes out', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ casesEnabled: true }))
    reply(promise)
    await dispatchInboundToAiReply(ARGS)
    expect(h.openCase).toHaveBeenCalledTimes(1)
    expect(h.openCase.mock.calls[0][1]).toMatchObject({ openedBy: 'system', conversationId: 'conv-1' })
    expect(h.engineSendText).toHaveBeenCalled()
  })

  it('does not open another when one is already open', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ casesEnabled: true }))
    h.loadOpenCases.mockResolvedValue([{ id: 'c1', title: 't', status: 'awaiting_human', pending_note: null }])
    reply(promise)
    await dispatchInboundToAiReply(ARGS)
    expect(h.openCase).not.toHaveBeenCalled()
  })

  it('cases off: the old behaviour, nothing opened', async () => {
    reply(promise)
    await dispatchInboundToAiReply(ARGS)
    expect(h.openCase).not.toHaveBeenCalled()
  })
})

describe('dropEchoedPrompts', () => {
  const intro = 'Sem problemas, Raylson! Tenho estes horários disponíveis para amanhã:'
  it('drops a bubble that repeats the list text already sent', () => {
    expect(dropEchoedPrompts(['Sem problemas, Raylson! Tenho estes horários disponíveis para amanhã:'], [intro])).toEqual([])
    expect(dropEchoedPrompts(['sem problemas, raylson'], [intro])).toEqual([])
  })
  it('keeps new content', () => {
    expect(dropEchoedPrompts(['Qualquer dúvida me chama!'], [intro])).toEqual(['Qualquer dúvida me chama!'])
    expect(dropEchoedPrompts(['Oi'], [])).toEqual(['Oi'])
  })
})
