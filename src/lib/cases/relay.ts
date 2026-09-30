// ============================================================
// The relay turn (specs/human-cases.md §4): after a teammate answers a
// case, the AI tells the customer — the intent comes from the button
// ("done" / "need info"), not from the model's interpretation. The
// teammate's note is untrusted text: capped, no tools in this turn, and an
// instruction never to disclose internal notes.
//
// Official API: past 24h only a template goes out, so a closed window is
// reported to the team instead of attempting a doomed free-form send.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { loadAiConfig } from '@/lib/ai/config'
import { buildConversationContext } from '@/lib/ai/context'
import { buildSystemPrompt } from '@/lib/ai/defaults'
import { generateReplyWithFallback } from '@/lib/ai/generate-with-fallback'
import { logAiUsage } from '@/lib/ai/usage'
import { splitLongText } from '@/lib/ai/split-long'
import { engineSendText } from '@/lib/flows/meta-send'
import { resolveAuditUserId } from '@/lib/api/v1/contacts'
import { windowState } from '@/lib/inbox/signals'
import { logEvent, notifyTeam } from './store'

export type RelayResult = 'sent' | 'window_closed' | 'failed' | 'skipped'

export function relayInstruction(action: 'done' | 'need_info', title: string, note: string): string {
  const safe = note.replace(/\s+/g, ' ').trim().slice(0, 1000)
  return action === 'done'
    ? `The team resolved the case "${title}". Their internal note: "${safe}". Tell the customer the outcome naturally and briefly, as the next message of this conversation. Share only what the customer needs to know; never quote or reveal internal notes, names of tools or internal details.`
    : `To resolve the case "${title}" the team needs from the customer: "${safe}". Ask the customer for exactly that, naturally and briefly. Never quote or reveal internal notes.`
}

export async function relayCase(db: SupabaseClient, accountId: string, caseId: string): Promise<RelayResult> {
  // Claim: only one relay per pending note (a cron retry and the route's
  // own run can race).
  const { data: claimed } = await db
    .from('human_cases')
    .update({ relay_status: 'sent', updated_at: new Date().toISOString() })
    .eq('id', caseId)
    .eq('account_id', accountId)
    .eq('relay_status', 'pending')
    .select('id, conversation_id, contact_id, title, pending_note, pending_action')
  const c = (claimed as {
    id: string
    conversation_id: string
    contact_id: string
    title: string
    pending_note: string | null
    pending_action: 'done' | 'need_info' | null
  }[] | null)?.[0]
  if (!c || !c.pending_action) return 'skipped'

  const fail = async (status: 'failed' | 'window_closed', why: string) => {
    await db.from('human_cases').update({ relay_status: status }).eq('id', c.id)
    await logEvent(db, { caseId: c.id, accountId, kind: 'relay_failed', actorKind: 'system', body: why })
    await notifyTeam(db, {
      accountId,
      conversationId: c.conversation_id,
      contactId: c.contact_id,
      type: 'case_relay_failed',
      title: `Cliente não foi avisado: ${c.title}`,
      body:
        status === 'window_closed'
          ? 'A janela de 24h do número oficial está fechada. Envie um template ou assuma a conversa.'
          : 'A IA não conseguiu enviar a mensagem. Assuma a conversa.',
    })
    return status
  }

  try {
    const { data: conv } = await db
      .from('conversations')
      .select('whatsapp_channel_id, last_customer_message_at, pinned_ai_agent_id')
      .eq('id', c.conversation_id)
      .maybeSingle()
    const win = windowState({
      isOfficialApi: !conv?.whatsapp_channel_id,
      lastCustomerMessageAt: conv?.last_customer_message_at ?? null,
      now: new Date(),
    })
    if (win.kind === 'closed') return fail('window_closed', 'window_closed')

    const config = await loadAiConfig(
      db,
      accountId,
      conv?.pinned_ai_agent_id ? { agentId: conv.pinned_ai_agent_id } : undefined,
    )
    if (!config) return fail('failed', 'no_agent')

    const messages = await buildConversationContext(db, c.conversation_id)
    const systemPrompt = `${buildSystemPrompt({ userPrompt: config.systemPrompt, mode: 'auto_reply' })}\n\n${relayInstruction(c.pending_action, c.title, c.pending_note ?? '')}`
    const generation = await generateReplyWithFallback({
      config,
      systemPrompt,
      messages: messages.length > 0 ? messages : [{ role: 'user', content: '(no messages)' }],
    })
    void logAiUsage(db, {
      accountId,
      conversationId: c.conversation_id,
      agentId: config.id ?? null,
      mode: 'auto_reply',
      provider: generation.provider,
      model: generation.model,
      usage: generation.usage,
    })
    if (generation.handoff || !generation.text.trim()) return fail('failed', 'empty_reply')

    const userId = await resolveAuditUserId(db, accountId)
    const segments = (generation.segments.length > 0 ? generation.segments : [generation.text]).flatMap((s) =>
      splitLongText(s),
    )
    for (const text of segments) {
      await engineSendText({
        accountId,
        userId,
        conversationId: c.conversation_id,
        contactId: c.contact_id,
        text,
        aiGenerated: true,
      })
    }
    await db.from('human_cases').update({ pending_note: null }).eq('id', c.id)
    await logEvent(db, { caseId: c.id, accountId, kind: 'relay_sent', actorKind: 'ai', body: generation.text })
    return 'sent'
  } catch (err) {
    console.error(`[cases ${caseId}] relay failed:`, err)
    return fail('failed', err instanceof Error ? err.message.slice(0, 200) : 'error')
  }
}

/** Cron: retry relays whose route run was frozen before finishing. */
export async function retryPendingRelays(db: SupabaseClient): Promise<number> {
  const cutoff = new Date(Date.now() - 2 * 60_000).toISOString()
  const { data } = await db
    .from('human_cases')
    .select('id, account_id')
    .eq('relay_status', 'pending')
    .lte('updated_at', cutoff)
    .limit(10)
  let n = 0
  for (const r of data ?? []) {
    if ((await relayCase(db, r.account_id as string, r.id as string)) === 'sent') n++
  }
  return n
}
