import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { buildConversationContext } from './context'

/** Minimal fake matching the query chain in buildConversationContext:
 *  from().select().eq().in().order().limit() → { data, error }. */
function fakeDb(rows: unknown[]): SupabaseClient {
  const chain = {
    from: () => chain,
    select: () => chain,
    eq: () => chain,
    in: () => chain,
    order: () => chain,
    limit: () => Promise.resolve({ data: rows, error: null }),
  }
  return chain as unknown as SupabaseClient
}

describe('buildConversationContext', () => {
  it('maps sender_type to role and returns chronological order', async () => {
    // DB returns newest-first (created_at DESC); the fn reverses it.
    const rows = [
      { sender_type: 'customer', content_text: 'third' },
      { sender_type: 'agent', content_text: 'second' },
      { sender_type: 'customer', content_text: 'first' },
    ]
    const out = await buildConversationContext(fakeDb(rows), 'conv-1')
    expect(out).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'second' },
      { role: 'user', content: 'third' },
    ])
  })

  it('includes a sent template as the business turn, marked', async () => {
    const out = await buildConversationContext(
      fakeDb([
        { sender_type: 'customer', content_text: 'Explica isso?' },
        { sender_type: 'bot', content_type: 'template', content_text: 'Frete grátis hoje' },
      ]),
      'conv-1',
    )
    expect(out).toEqual([
      { role: 'assistant', content: '[modelo enviado] Frete grátis hoje' },
      { role: 'user', content: 'Explica isso?' },
    ])
  })

  it('treats bot messages as assistant', async () => {
    const out = await buildConversationContext(
      fakeDb([{ sender_type: 'bot', content_text: 'auto reply' }]),
      'conv-1',
    )
    expect(out).toEqual([{ role: 'assistant', content: 'auto reply' }])
  })

  it('drops empty / whitespace-only messages', async () => {
    const out = await buildConversationContext(
      fakeDb([
        { sender_type: 'customer', content_text: '   ' },
        { sender_type: 'customer', content_text: null },
        { sender_type: 'customer', content_text: 'real' },
      ]),
      'conv-1',
    )
    expect(out).toEqual([{ role: 'user', content: 'real' }])
  })

  it('includes an interactive tap, appending its stable id', async () => {
    const out = await buildConversationContext(
      fakeDb([
        {
          sender_type: 'customer',
          content_text: 'ter 24/09 09:30',
          interactive_reply_id: 'slot:2026-09-24T12:30:00.000Z',
        },
      ]),
      'conv-1',
    )
    expect(out).toEqual([
      { role: 'user', content: 'ter 24/09 09:30 (id: slot:2026-09-24T12:30:00.000Z)' },
    ])
  })

  it('does not append an id for a bot interactive prompt (no interactive_reply_id)', async () => {
    const out = await buildConversationContext(
      fakeDb([{ sender_type: 'bot', content_text: 'Encontrei esses horários livres:' }]),
      'conv-1',
    )
    expect(out).toEqual([{ role: 'assistant', content: 'Encontrei esses horários livres:' }])
  })
})

describe('buildConversationContext — author labels', () => {
  /** messages → rows; ai_configs .in() → the agents' names. */
  function labelledDb(rows: unknown[], agents: { id: string; name: string }[]) {
    return {
      from: (table: string) => {
        const chain = {
          select: () => chain,
          eq: () => chain,
          order: () => chain,
          in: () =>
            table === 'ai_configs'
              ? Promise.resolve({ data: agents, error: null })
              : chain,
          limit: () => Promise.resolve({ data: rows, error: null }),
        }
        return chain
      },
    } as unknown as SupabaseClient
  }

  // Newest first, as the DB returns them.
  const rows = [
    { sender_type: 'bot', content_text: 'mine', ai_generated: true, ai_agent_id: 'me' },
    { sender_type: 'bot', content_text: 'sales said', ai_generated: true, ai_agent_id: 'sales' },
    { sender_type: 'agent', content_text: 'human said' },
    { sender_type: 'bot', content_text: 'auto said', ai_generated: false },
    { sender_type: 'bot', content_text: 'old ai', ai_generated: true, ai_agent_id: null },
    { sender_type: 'customer', content_text: 'hi' },
  ]

  it('labels turns this agent did not write, by author', async () => {
    const out = await buildConversationContext(
      labelledDb(rows, [{ id: 'sales', name: 'Vendas' }]),
      'conv-1',
      undefined,
      { selfAgentId: 'me' }
    )
    expect(out.map((m) => m.content)).toEqual([
      'hi',
      'old ai',
      '[enviada por uma automação] auto said',
      '[enviada por um atendente humano] human said',
      '[enviada pelo agente "Vendas"] sales said',
      'mine',
    ])
  })

  it('leaves the transcript plain for callers that do not ask', async () => {
    const out = await buildConversationContext(labelledDb(rows, []), 'conv-1')
    expect(out.every((m) => !m.content.startsWith('[enviada'))).toBe(true)
  })
})
