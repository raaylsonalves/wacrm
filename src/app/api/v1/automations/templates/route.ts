// ============================================================
// GET /api/v1/automations/templates — list quick-start automation
// templates (scope: automations:read).
//
// Lets an MCP client discover valid `template` slugs before calling
// POST /api/v1/automations with one, instead of guessing.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, toApiErrorResponse } from '@/lib/api/v1/respond';
import {
  AUTOMATION_TEMPLATES,
  loadServerTemplateTranslator,
  resolveAutomationTemplate,
  type TemplateSlug,
} from '@/lib/automations/templates';

export async function GET(request: Request) {
  try {
    await requireApiKey(request, 'automations:read');

    const templates = await Promise.all(
      (Object.keys(AUTOMATION_TEMPLATES) as TemplateSlug[]).map(async (slug) => {
        const tTemplate = await loadServerTemplateTranslator(slug);
        const t = resolveAutomationTemplate(slug, tTemplate);
        return {
          slug,
          name: t.name,
          description: t.description,
          trigger_type: t.trigger_type,
        };
      }),
    );

    return ok(templates);
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
