import type { SupabaseClient } from '@supabase/supabase-js'
import type { ToolDefinition, ToolExecutor } from '../types'

// ============================================================
// qualify_lead — the only pipeline move the AI can make, and only for a
// conversation that came from a prospecting campaign: it moves THIS
// conversation's deal to THAT campaign's qualified stage. The agent never
// picks a destination (specs/prospecting-csv-import.md §4.6); the stamp
// qualified_at is set by the database trigger on the stage change, the
// same one a person dragging the card fires.
// ============================================================

export interface ProspectContext {
  dealId: string
  qualifiedStageId: string
  criteria: string
}

/** The open prospecting deal of this conversation, if any. Never throws. */
export async function loadProspectContext(
  db: SupabaseClient,
  conversationId: string,
): Promise<ProspectContext | null> {
  try {
    const { data } = await db
      .from('prospecting_candidates')
      .select('deal_id, qualified_at, campaign:prospecting_campaigns(config)')
      .eq('conversation_id', conversationId)
      .not('deal_id', 'is', null)
      .is('qualified_at', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    const row = data as {
      deal_id: string
      campaign: { config: { qualified_stage_id?: string; criteria?: string } } | null
    } | null
    const stage = row?.campaign?.config?.qualified_stage_id
    if (!row?.deal_id || !stage) return null
    return { dealId: row.deal_id, qualifiedStageId: stage, criteria: row.campaign?.config?.criteria ?? '' }
  } catch {
    return null
  }
}

export const PROSPECTING_TOOLS: ToolDefinition[] = [
  {
    name: 'qualify_lead',
    description:
      'Marks this lead as qualified in the sales pipeline. Call it ONLY after the customer has confirmed every qualification criterion in the conversation. Never call it on a guess.',
    parameters: {
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          description: 'One or two sentences with what the customer confirmed, for the sales team.',
        },
      },
      required: ['summary'],
    },
  },
]

/** Prompt text telling the agent what "qualified" means for this lead. */
export function prospectPromptLine(ctx: ProspectContext): string {
  return `This conversation started from a prospecting approach. Qualification criteria: ${ctx.criteria}\nWhen the customer has confirmed all of them, call qualify_lead once with a short summary.`
}

export function createProspectingToolExecutor(args: {
  db: SupabaseClient
  accountId: string
  ctx: ProspectContext
}): ToolExecutor {
  return async (name, callArgs) => {
    if (name !== 'qualify_lead') return JSON.stringify({ error: `Unknown tool: ${name}` })
    const summary = typeof callArgs.summary === 'string' ? callArgs.summary.trim().slice(0, 1000) : ''
    if (!summary) return JSON.stringify({ error: 'summary is required' })

    const { data: deal } = await args.db
      .from('deals')
      .select('notes')
      .eq('id', args.ctx.dealId)
      .eq('account_id', args.accountId)
      .maybeSingle()
    if (!deal) return JSON.stringify({ error: 'deal not found' })

    const { error } = await args.db
      .from('deals')
      .update({
        stage_id: args.ctx.qualifiedStageId,
        notes: `${deal.notes ?? ''}\n\nQualificado pela IA: ${summary}`.trim().slice(0, 8000),
        updated_at: new Date().toISOString(),
      })
      .eq('id', args.ctx.dealId)
      .eq('account_id', args.accountId)
    if (error) {
      console.error('[ai prospecting tool] qualify failed:', error)
      return JSON.stringify({ error: 'failed to qualify' })
    }
    return JSON.stringify({ success: true })
  }
}
