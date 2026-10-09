import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { AiConfig } from './types';

const h = vi.hoisted(() => ({
  loadAiConfig: vi.fn(),
  generateReply: vi.fn(),
}));

vi.mock('./config', () => ({ loadAiConfig: h.loadAiConfig }));
vi.mock('./generate', () => ({ generateReply: h.generateReply }));

import { loadActiveRouterForChannel, resolveAgentViaRouter } from './router';

const DEFAULT_CONFIG: AiConfig = {
  id: 'agent-default',
  provider: 'openai',
  model: 'gpt-4o-mini',
  apiKey: 'key',
  systemPrompt: null,
  isActive: true,
  autoReplyEnabled: true,
  autoReplyMaxPerConversation: 3,
  handoffAgentId: null,
  embeddingsApiKey: null,
  fallbacks: [],
  agendaEnabled: false,
};

function fakeDb(tables: Record<string, unknown>) {
  return {
    from: (table: string) => {
      const chain = tables[table];
      if (!chain) throw new Error(`unexpected table in test: ${table}`);
      return chain;
    },
  } as never;
}

describe('loadActiveRouterForChannel', () => {
  const MEMBERS = [
    {
      agent_id: 'agent-sales',
      intent_name: 'sales',
      intent_description: 'wants to buy',
      examples: [],
    },
  ];
  function dbWith(routers: unknown[], members: unknown[] = MEMBERS) {
    return fakeDb({
      ai_routers: {
        select: () => ({
          eq: () => ({
            eq: () => Promise.resolve({ data: routers, error: null }),
          }),
        }),
      },
      ai_router_members: {
        select: () => ({
          eq: () => ({
            order: () => Promise.resolve({ data: members, error: null }),
          }),
        }),
      },
    });
  }
  const ACCOUNT = { id: 'router-account', channel_id: null, whatsapp_config_id: null };
  const CHANNEL = { id: 'router-channel', channel_id: 'chan-1', whatsapp_config_id: null };
  const OFFICIAL = { id: 'router-official', channel_id: null, whatsapp_config_id: 'cfg-1' };

  it('returns null when no active router exists', async () => {
    expect(await loadActiveRouterForChannel(dbWith([]), 'acc-1', null)).toBeNull();
  });

  it('returns null when the active router has no members configured', async () => {
    expect(
      await loadActiveRouterForChannel(dbWith([ACCOUNT], []), 'acc-1', null)
    ).toBeNull();
  });

  it('prefers a channel-specific router over a whole-account one', async () => {
    const r = await loadActiveRouterForChannel(dbWith([ACCOUNT, CHANNEL]), 'acc-1', 'chan-1');
    expect(r?.router.id).toBe('router-channel');
  });

  it("picks the official number's own router", async () => {
    const db = dbWith([ACCOUNT, CHANNEL, OFFICIAL]);
    expect((await loadActiveRouterForChannel(db, 'acc-1', null, 'cfg-1'))?.router.id).toBe(
      'router-official'
    );
    // another official number falls back to the whole-account router
    expect((await loadActiveRouterForChannel(db, 'acc-1', null, 'cfg-2'))?.router.id).toBe(
      'router-account'
    );
  });

  it('skips the whole-account router when asked (agent bound to the number)', async () => {
    const db = dbWith([ACCOUNT, OFFICIAL]);
    expect(
      await loadActiveRouterForChannel(db, 'acc-1', null, 'cfg-2', { skipWholeAccount: true })
    ).toBeNull();
    expect(
      (await loadActiveRouterForChannel(db, 'acc-1', null, 'cfg-1', { skipWholeAccount: true }))
        ?.router.id
    ).toBe('router-official');
  });
});

describe('resolveAgentViaRouter', () => {
  const members = [
    {
      agent_id: 'agent-sales',
      intent_name: 'sales',
      intent_description: 'wants to buy something',
      examples: ['how much is it'],
    },
    {
      agent_id: 'agent-support',
      intent_name: 'support',
      intent_description: 'has a problem with an order',
      examples: ['my order never arrived'],
    },
  ];
  const router = {
    id: 'router-1',
    account_id: 'acc-1',
    channel_id: null,
    whatsapp_config_id: null,
    classifier_model: null,
    min_confidence: 0.6,
    sticky: true,
    fallback_agent_id: null,
  };

  beforeEach(() => {
    h.loadAiConfig.mockReset();
    h.generateReply.mockReset();
  });

  it('reuses the sticky agent without reclassifying', async () => {
    const stickyConfig = { ...DEFAULT_CONFIG, id: 'agent-sales' };
    h.loadAiConfig.mockResolvedValue(stickyConfig);
    const db = fakeDb({});

    const result = await resolveAgentViaRouter({
      db,
      accountId: 'acc-1',
      conversationId: 'conv-1',
      defaultConfig: DEFAULT_CONFIG,
      activeRouter: { router, members },
      currentAgentId: 'agent-sales',
      messageText: 'anything',
    });

    expect(result).toBe(stickyConfig);
    expect(h.generateReply).not.toHaveBeenCalled();
  });

  it('never answers with an agent whose auto-reply is off (A4)', async () => {
    h.generateReply.mockResolvedValue({
      text: '{"intent": "sales", "confidence": 0.9}',
      segments: [],
      handoff: false,
      usage: null,
    });
    h.loadAiConfig.mockResolvedValue({ ...DEFAULT_CONFIG, id: 'agent-sales', autoReplyEnabled: false });
    const db = fakeDb({
      conversations: {
        update: () => ({ eq: () => ({ eq: () => Promise.resolve({ error: null }) }) }),
      },
    });
    const result = await resolveAgentViaRouter({
      db,
      accountId: 'acc-1',
      conversationId: 'conv-1',
      defaultConfig: DEFAULT_CONFIG,
      activeRouter: { router, members },
      currentAgentId: null,
      messageText: 'how much is it',
    });
    expect(result).toBe(DEFAULT_CONFIG);
  });

  it('drops a sticky agent that no longer belongs to the router (A14)', async () => {
    h.generateReply.mockResolvedValue({
      text: '{"intent": "none", "confidence": 0}',
      segments: [],
      handoff: false,
      usage: null,
    });
    h.loadAiConfig.mockResolvedValue({ ...DEFAULT_CONFIG, id: 'agent-removed' });
    const db = fakeDb({
      conversations: {
        update: () => ({ eq: () => ({ eq: () => Promise.resolve({ error: null }) }) }),
      },
    });
    await resolveAgentViaRouter({
      db,
      accountId: 'acc-1',
      conversationId: 'conv-1',
      defaultConfig: DEFAULT_CONFIG,
      activeRouter: { router, members },
      currentAgentId: 'agent-removed',
      messageText: 'hi',
    });
    // it reclassified instead of reusing the removed agent
    expect(h.generateReply).toHaveBeenCalled();
  });

  it('classifies and loads the matched agent above the confidence threshold', async () => {
    h.generateReply.mockResolvedValue({
      text: '{"intent": "sales", "confidence": 0.9}',
      segments: [],
      handoff: false,
      usage: null,
    });
    const salesConfig = { ...DEFAULT_CONFIG, id: 'agent-sales' };
    h.loadAiConfig.mockResolvedValue(salesConfig);
    let updatedTo: string | null = null;
    const db = fakeDb({
      conversations: {
        update: (payload: { active_ai_agent_id: string }) => {
          updatedTo = payload.active_ai_agent_id;
          return { eq: () => ({ eq: () => Promise.resolve({ error: null }) }) };
        },
      },
    });

    const result = await resolveAgentViaRouter({
      db,
      accountId: 'acc-1',
      conversationId: 'conv-1',
      defaultConfig: DEFAULT_CONFIG,
      activeRouter: { router, members },
      currentAgentId: null,
      messageText: 'how much is the pro plan',
    });

    expect(result).toBe(salesConfig);
    expect(h.loadAiConfig).toHaveBeenCalledWith(db, 'acc-1', {
      agentId: 'agent-sales',
    });
    expect(updatedTo).toBe('agent-sales');
  });

  it('falls back to the router fallback agent when confidence is below the minimum', async () => {
    h.generateReply.mockResolvedValue({
      text: '{"intent": "sales", "confidence": 0.2}',
      segments: [],
      handoff: false,
      usage: null,
    });
    const fallbackConfig = { ...DEFAULT_CONFIG, id: 'agent-fallback' };
    h.loadAiConfig.mockResolvedValue(fallbackConfig);
    const db = fakeDb({
      conversations: {
        update: () => ({ eq: () => ({ eq: () => Promise.resolve({ error: null }) }) }),
      },
    });

    const result = await resolveAgentViaRouter({
      db,
      accountId: 'acc-1',
      conversationId: 'conv-1',
      defaultConfig: DEFAULT_CONFIG,
      activeRouter: {
        router: { ...router, fallback_agent_id: 'agent-fallback' },
        members,
      },
      currentAgentId: null,
      messageText: 'how much is the pro plan',
    });

    expect(result).toBe(fallbackConfig);
  });

  it('falls back to the default agent when there is no router fallback and confidence is low', async () => {
    h.generateReply.mockResolvedValue({
      text: '{"intent": "none", "confidence": 0}',
      segments: [],
      handoff: false,
      usage: null,
    });
    const db = fakeDb({
      conversations: {
        update: () => ({ eq: () => ({ eq: () => Promise.resolve({ error: null }) }) }),
      },
    });

    const result = await resolveAgentViaRouter({
      db,
      accountId: 'acc-1',
      conversationId: 'conv-1',
      defaultConfig: DEFAULT_CONFIG,
      activeRouter: { router, members },
      currentAgentId: null,
      messageText: 'hello',
    });

    expect(result).toBe(DEFAULT_CONFIG);
  });

  it('falls back to the default agent when the classifier throws, never letting the error escape', async () => {
    h.generateReply.mockRejectedValue(new Error('provider timeout'));
    const db = fakeDb({
      conversations: {
        update: () => ({ eq: () => ({ eq: () => Promise.resolve({ error: null }) }) }),
      },
    });

    const result = await resolveAgentViaRouter({
      db,
      accountId: 'acc-1',
      conversationId: 'conv-1',
      defaultConfig: DEFAULT_CONFIG,
      activeRouter: { router, members },
      currentAgentId: null,
      messageText: 'hello',
    });

    expect(result).toBe(DEFAULT_CONFIG);
  });

  it('falls back to the default agent when the classifier returns unparseable text', async () => {
    h.generateReply.mockResolvedValue({
      text: 'not json at all',
      segments: [],
      handoff: false,
      usage: null,
    });
    const db = fakeDb({
      conversations: {
        update: () => ({ eq: () => ({ eq: () => Promise.resolve({ error: null }) }) }),
      },
    });

    const result = await resolveAgentViaRouter({
      db,
      accountId: 'acc-1',
      conversationId: 'conv-1',
      defaultConfig: DEFAULT_CONFIG,
      activeRouter: { router, members },
      currentAgentId: null,
      messageText: 'hello',
    });

    expect(result).toBe(DEFAULT_CONFIG);
  });
});
