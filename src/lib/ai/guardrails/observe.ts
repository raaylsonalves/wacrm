import type { SupabaseClient } from '@supabase/supabase-js'
import { BEFORE_SEND_CHAIN_VERSION, runBeforeSend, type GateContext, type Veto } from './gates'

const EXCERPT_LEN = 600

/**
 * Observe mode: run the before-send chain on the reply and record what it
 * would have blocked, WITHOUT blocking. Nothing here may delay or fail the
 * customer's reply, so it never throws and the caller doesn't await the
 * write. Returns the veto (or null) so tests and a future enforce mode
 * can act on it.
 */
export function observeBeforeSend(
  db: SupabaseClient,
  args: { accountId: string; conversationId: string; text: string; ctx: GateContext },
): Veto | null {
  let veto: Veto | null = null
  try {
    veto = runBeforeSend(args.text, args.ctx)
    if (!veto) return null
    void Promise.resolve(
      db.from('ai_guardrail_traces').insert({
        account_id: args.accountId,
        conversation_id: args.conversationId,
        chain_version: BEFORE_SEND_CHAIN_VERSION,
        gate: veto.gate,
        code: veto.code,
        mode: 'observe',
        reply_excerpt: args.text.slice(0, EXCERPT_LEN),
      }),
    )
      .then((res: { error?: { message: string } | null } | undefined) => {
        if (res?.error) console.warn('[ai guardrails] could not record trace:', res.error.message)
      })
      .catch((err: unknown) => console.warn('[ai guardrails] could not record trace:', err))
    console.info(`[ai guardrails] would veto (${veto.gate}/${veto.code}) — observe mode, sending anyway`)
  } catch (err) {
    console.warn('[ai guardrails] check failed:', err)
  }
  return veto
}
