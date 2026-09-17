// ============================================================
// GET /api/v1/flows/templates — list quick-start flow templates
// (scope: flows:read).
//
// Lets an MCP client discover valid `template_slug` values before
// calling POST /api/v1/flows with one, instead of guessing.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, toApiErrorResponse } from '@/lib/api/v1/respond';
import {
  listFlowTemplates,
  loadServerFlowTemplateTranslator,
} from '@/lib/flows/templates';

export async function GET(request: Request) {
  try {
    await requireApiKey(request, 'flows:read');

    const templates = await Promise.all(
      listFlowTemplates().map(async (t) => {
        const tTemplate = await loadServerFlowTemplateTranslator(t.slug);
        return {
          slug: t.slug,
          name: tTemplate('name'),
          description: tTemplate('description'),
          trigger_type: t.trigger_type,
        };
      }),
    );

    return ok(templates);
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
