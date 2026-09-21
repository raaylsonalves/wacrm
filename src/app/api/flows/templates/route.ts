import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { listFlowTemplates, loadServerFlowTemplateTranslator } from '@/lib/flows/templates'

/**
 * GET /api/flows/templates
 *
 * Returns the static template gallery (slug + name + description +
 * icon hint + node_count) so the New-flow dialog can render cards
 * without bundling the full template payloads client-side. Bodies
 * are fetched only on actual clone via POST /api/flows.
 *
 * Available to any signed-in user. Flows is in soft-GA.
 */
export async function GET() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  // Shallow shape so the client gallery doesn't have to know about
  // the full node tree. Name/description resolved through
  // messages/*.json — the module's own values are an English fallback
  // (see resolveFlowTemplate), not what should render in the gallery.
  const templates = await Promise.all(
    listFlowTemplates().map(async (t) => {
      const tTemplate = await loadServerFlowTemplateTranslator(t.slug)
      return {
        slug: t.slug,
        name: tTemplate('name'),
        description: tTemplate('description'),
        icon: t.icon,
        trigger_type: t.trigger_type,
        node_count: t.nodes.length,
      }
    }),
  )
  return NextResponse.json({ templates })
}
