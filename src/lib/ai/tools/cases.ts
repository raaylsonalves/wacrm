import type { SupabaseClient } from '@supabase/supabase-js'
import type { ToolDefinition, ToolExecutor } from '../types'
import { openCase, notifyTeam, transitionCase } from '@/lib/cases/store'

// ============================================================
// Case tools (specs/human-cases.md §2). A case is the AI saying "I can't
// do this myself, but I'll keep talking to the customer while a teammate
// does it" — it never silences the AI. Every failure returns
// {"error": "..."} so the model can react, as the other executors do.
// ============================================================

export interface OpenCaseSummary {
  id: string
  title: string
  status: 'awaiting_human' | 'awaiting_lead'
  pending_note: string | null
}

/** The conversation's open cases, for the prompt. Never throws. */
export async function loadOpenCases(db: SupabaseClient, conversationId: string): Promise<OpenCaseSummary[]> {
  try {
    const { data } = await db
      .from('human_cases')
      .select('id, title, status, pending_note')
      .eq('conversation_id', conversationId)
      .in('status', ['awaiting_human', 'awaiting_lead'])
      .order('opened_at', { ascending: true })
    return (data ?? []) as OpenCaseSummary[]
  } catch {
    return []
  }
}

export const CASE_TOOLS: ToolDefinition[] = [
  {
    name: 'open_human_case',
    description:
      "Open a case for the team when you cannot solve the customer's request yourself (grant access, fix something in a system, check a payment, a decision only a person can make). You KEEP talking to the customer — this does not silence you; tell them the team is on it. Use it EVERY time you are about to promise that someone will check or resolve something: promising without opening a case is forbidden. Do not open a second case for the same request.",
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short task title for the team (max 120 chars), e.g. "Liberar acesso ao painel".' },
        summary: { type: 'string', description: 'What the customer needs and what you already know (max 1000 chars).' },
        blocker: { type: 'string', description: 'Exactly what you cannot do yourself and the team must do (max 500 chars).' },
      },
      required: ['title', 'summary', 'blocker'],
    },
  },
  {
    name: 'provide_case_update',
    description:
      'Send the team the information they asked the customer for, on a case waiting for the customer. Call it as soon as the customer gives that information.',
    parameters: {
      type: 'object',
      properties: {
        case_id: { type: 'string', description: 'The id of the open case, as listed in your instructions.' },
        info: { type: 'string', description: 'What the customer provided (max 1000 chars).' },
      },
      required: ['case_id', 'info'],
    },
  },
]

/** Prompt section: how to use cases, and the ones already open here. */
export function casesPromptSection(open: OpenCaseSummary[]): string {
  const lines = [
    'Cases: when you cannot solve something yourself, call open_human_case and keep helping the customer — tell them the team is taking care of it. Never promise a person will check something without opening a case.',
  ]
  if (open.length > 0) {
    lines.push('Open cases in this conversation:')
    for (const c of open) {
      lines.push(
        c.status === 'awaiting_lead'
          ? `- ${c.id} "${c.title}": the team needs from the customer: ${c.pending_note ?? '(see case)'}. Ask for it; when they answer, call provide_case_update.`
          : `- ${c.id} "${c.title}": waiting for the team. Do not open another case for it.`,
      )
    }
  }
  return lines.join('\n')
}

const own = (o: Record<string, unknown>, k: string) => Object.prototype.hasOwnProperty.call(o, k)
function strictString(args: Record<string, unknown>, key: string, max: number): string | null {
  if (!own(args, key) || typeof args[key] !== 'string') return null
  const v = (args[key] as string).trim()
  return v && v.length <= max ? v : null
}

export function createCaseToolExecutor(ctx: {
  db: SupabaseClient
  accountId: string
  conversationId: string
  contactId: string
  /** Set when open_human_case succeeds this turn (the fail-safe reads it). */
  onOpened?: () => void
}): ToolExecutor {
  return async (name, args) => {
    const allowed =
      name === 'open_human_case' ? ['title', 'summary', 'blocker'] : name === 'provide_case_update' ? ['case_id', 'info'] : null
    if (!allowed) return JSON.stringify({ error: `Unknown tool: ${name}` })
    const extra = Object.keys(args).filter((k) => !allowed.includes(k))
    if (extra.length > 0) return JSON.stringify({ error: `Unknown field(s): ${extra.join(', ')}` })

    if (name === 'open_human_case') {
      const title = strictString(args, 'title', 120)
      const summary = strictString(args, 'summary', 1000)
      const blocker = strictString(args, 'blocker', 500)
      if (!title || !summary || !blocker) {
        return JSON.stringify({ error: 'title (≤120), summary (≤1000) and blocker (≤500) are required text fields' })
      }
      const r = await openCase(ctx.db, {
        accountId: ctx.accountId,
        conversationId: ctx.conversationId,
        contactId: ctx.contactId,
        title,
        summary,
        blocker,
        openedBy: 'ai',
      })
      if (!r.ok) {
        return JSON.stringify({
          error:
            r.error === 'too_many_open'
              ? 'This conversation already has the maximum of open cases. Use the existing one.'
              : 'The case could not be opened right now. Tell the customer the team will be informed, without inventing a deadline.',
        })
      }
      ctx.onOpened?.()
      return JSON.stringify({ success: true, case_id: r.caseId, next: 'Tell the customer the team is handling it. Keep helping with anything else.' })
    }

    // provide_case_update — the case must belong to THIS conversation.
    const caseId = strictString(args, 'case_id', 64)
    const info = strictString(args, 'info', 1000)
    if (!caseId || !info) return JSON.stringify({ error: 'case_id and info are required' })
    const { data: c } = await ctx.db
      .from('human_cases')
      .select('id, title, conversation_id')
      .eq('id', caseId)
      .eq('account_id', ctx.accountId)
      .eq('conversation_id', ctx.conversationId)
      .maybeSingle()
    if (!c) return JSON.stringify({ error: 'No such case in this conversation.' })
    const t = await transitionCase(ctx.db, {
      accountId: ctx.accountId,
      caseId,
      action: 'lead_provided',
      actorKind: 'ai',
      note: info,
    })
    if (!t.ok) return JSON.stringify({ error: 'This case is not waiting for the customer.' })
    if (!t.noop) {
      await notifyTeam(ctx.db, {
        accountId: ctx.accountId,
        conversationId: ctx.conversationId,
        contactId: ctx.contactId,
        type: 'case_lead_replied',
        title: `Cliente respondeu: ${c.title}`,
        body: info,
      })
    }
    return JSON.stringify({ success: true, next: 'Tell the customer you passed it on to the team.' })
  }
}
