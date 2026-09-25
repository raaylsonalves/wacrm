import type { SupabaseClient } from '@supabase/supabase-js'
import type { ToolDefinition, ToolExecutor } from '../types'

// ============================================================
// Identity tool for the AI auto-reply agent — lets it persist a name
// the customer gives mid-conversation, independent of the agenda
// tools (agenda.ts) and always available, since knowing who you're
// talking to isn't specific to booking. WhatsApp's own profile name
// already seeds `contacts.name` at contact creation (see
// findOrCreateContact / wa-identity.ts), so this only matters when
// that's missing/generic or the customer gives a different name to
// go by.
// ============================================================

export interface ContactToolContext {
  db: SupabaseClient
  accountId: string
  contactId: string
}

export const CONTACT_TOOLS: ToolDefinition[] = [
  {
    name: 'save_contact_name',
    description:
      "Saves the customer's name to their CRM contact record so future conversations already know it and you never have to ask again. Call this right after the customer tells you their name.",
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: "The customer's name exactly as they gave it — first name is enough.",
        },
      },
      required: ['name'],
    },
  },
]

/** Runs `save_contact_name`. Every failure — bad args, a DB error —
 *  comes back as `{"error": "..."}"` so the model can react instead of
 *  the whole reply throwing (mirrors `createAgendaToolExecutor`). */
export function createContactToolExecutor(ctx: ContactToolContext): ToolExecutor {
  return async (name, args) => {
    if (name !== 'save_contact_name') {
      return JSON.stringify({ error: `Unknown tool: ${name}` })
    }
    const value = typeof args.name === 'string' ? args.name.trim() : ''
    if (!value) return JSON.stringify({ error: 'name is required' })
    if (value.length > 200) return JSON.stringify({ error: 'name is too long' })

    const { error } = await ctx.db
      .from('contacts')
      .update({ name: value, updated_at: new Date().toISOString() })
      .eq('id', ctx.contactId)
      .eq('account_id', ctx.accountId)
    if (error) {
      console.error('[ai contact tool] failed to save contact name:', error)
      return JSON.stringify({ error: 'failed to save name' })
    }
    return JSON.stringify({ success: true })
  }
}
