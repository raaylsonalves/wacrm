import { describe, it, expect, vi } from 'vitest'
import { logAiUsage } from './usage'
import type { SupabaseClient } from '@supabase/supabase-js'

function fakeDb() {
  const insert = vi.fn().mockResolvedValue({ error: null })
  const db = { from: vi.fn(() => ({ insert })) }
  return { db: db as unknown as SupabaseClient, insert, from: db.from }
}

describe('logAiUsage', () => {
  it('inserts a row mapping normalized usage to the log columns', async () => {
    const { db, insert, from } = fakeDb()
    await logAiUsage(db, {
      accountId: 'acct-1',
      conversationId: 'conv-1',
      agentId: 'agent-1',
      mode: 'auto_reply',
      provider: 'anthropic',
      model: 'claude-x',
      usage: { promptTokens: 30, completionTokens: 6, totalTokens: 36 },
    })
    expect(from).toHaveBeenCalledWith('ai_usage_log')
    expect(insert).toHaveBeenCalledWith({
      account_id: 'acct-1',
      conversation_id: 'conv-1',
      agent_id: 'agent-1',
      mode: 'auto_reply',
      provider: 'anthropic',
      model: 'claude-x',
      prompt_tokens: 30,
      completion_tokens: 6,
      total_tokens: 36,
      cached_tokens: null,
    })
  })

  it('records the cached share when the provider reported it', async () => {
    const { db, insert } = fakeDb()
    await logAiUsage(db, {
      accountId: 'a',
      conversationId: null,
      mode: 'auto_reply',
      provider: 'openai',
      model: 'gpt-x',
      usage: { promptTokens: 1000, completionTokens: 10, totalTokens: 1010, cachedTokens: 800 },
    })
    expect(insert.mock.calls[0][0]).toMatchObject({ prompt_tokens: 1000, cached_tokens: 800 })
  })

  it('a reported zero stays 0, an unreported value stays NULL', async () => {
    const { db, insert } = fakeDb()
    const args = { accountId: 'a', conversationId: null, mode: 'auto_reply' as const, provider: 'openai' as const, model: 'm' }
    await logAiUsage(db, { ...args, usage: { promptTokens: 5, completionTokens: 1, totalTokens: 6, cachedTokens: 0 } })
    await logAiUsage(db, { ...args, usage: { promptTokens: 5, completionTokens: 1, totalTokens: 6 } })
    expect(insert.mock.calls[0][0].cached_tokens).toBe(0)
    expect(insert.mock.calls[1][0].cached_tokens).toBeNull()
  })

  it('keeps the spend row when the cached_tokens column does not exist yet', async () => {
    const insert = vi
      .fn()
      .mockResolvedValueOnce({ error: { code: '42703', message: 'column does not exist' } })
      .mockResolvedValueOnce({ error: null })
    const db = { from: vi.fn(() => ({ insert })) } as unknown as SupabaseClient
    await logAiUsage(db, {
      accountId: 'a',
      conversationId: null,
      mode: 'draft',
      provider: 'openai',
      model: 'm',
      usage: { promptTokens: 5, completionTokens: 1, totalTokens: 6, cachedTokens: 3 },
    })
    expect(insert).toHaveBeenCalledTimes(2)
    expect(insert.mock.calls[1][0]).not.toHaveProperty('cached_tokens')
  })

  it('is a no-op when the provider reported no usage', async () => {
    const { db, from } = fakeDb()
    await logAiUsage(db, {
      accountId: 'acct-1',
      conversationId: null,
      mode: 'draft',
      provider: 'openai',
      model: 'gpt-x',
      usage: null,
    })
    expect(from).not.toHaveBeenCalled()
  })

  it('never throws when the insert errors', async () => {
    const insert = vi.fn().mockResolvedValue({ error: { message: 'boom' } })
    const db = { from: vi.fn(() => ({ insert })) } as unknown as SupabaseClient
    await expect(
      logAiUsage(db, {
        accountId: 'acct-1',
        conversationId: 'conv-1',
        mode: 'draft',
        provider: 'openai',
        model: 'gpt-x',
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      }),
    ).resolves.toBeUndefined()
  })
})

describe('logAiUsage — agent attribution', () => {
  it('writes a NULL agent when the caller cannot attribute the call', async () => {
    const { db, insert } = fakeDb()
    await logAiUsage(db, {
      accountId: 'acct-1',
      conversationId: null,
      mode: 'draft',
      provider: 'openai',
      model: 'gpt-x',
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    })
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ agent_id: null }))
  })
})

describe('logAiUsage — audio rows', () => {
  it('records a speech row with characters and no tokens', async () => {
    const insert = vi.fn().mockResolvedValue({ error: null })
    const db = { from: vi.fn(() => ({ insert })) } as unknown as SupabaseClient
    await logAiUsage(db, {
      accountId: 'a',
      conversationId: 'c',
      mode: 'auto_reply',
      provider: 'openai',
      model: 'gpt-4o-mini-tts',
      usage: null,
      kind: 'speech',
      speechChars: 120,
    })
    expect(insert.mock.calls[0][0]).toMatchObject({ kind: 'speech', speech_chars: 120, total_tokens: 0 })
  })

  it('drops an audio row rather than mislabel it as chat on an unmigrated db', async () => {
    const insert = vi.fn().mockResolvedValue({ error: { code: '42703', message: 'no column' } })
    const db = { from: vi.fn(() => ({ insert })) } as unknown as SupabaseClient
    await logAiUsage(db, {
      accountId: 'a',
      conversationId: 'c',
      mode: 'auto_reply',
      provider: 'openai',
      model: 'm',
      usage: null,
      kind: 'speech',
      speechChars: 5,
    })
    expect(insert).toHaveBeenCalledTimes(1)
  })
})
