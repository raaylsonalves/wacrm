// ============================================================
// GET  /api/v1/automations  — list the account's automations (scope: automations:read)
// POST /api/v1/automations  — create an automation (scope: automations:write)
//
// Create supports the same two paths the dashboard builder does
// (`src/app/api/automations/route.ts`): either `template` (clone a
// quick-start template's trigger + step list) or a fully custom
// `trigger_type`/`trigger_config`/`steps`. Activating (`is_active:
// true`) runs the same pre-activation validation the dashboard uses,
// so an MCP client can't publish a broken automation any more easily
// than a human can through the builder.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, okList, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { resolveAuditUserId } from '@/lib/api/v1/contacts';
import {
  getTemplate,
  loadServerTemplateTranslator,
  resolveAutomationTemplate,
  type TemplateSlug,
} from '@/lib/automations/templates';
import { insertSteps, type BuilderStepInput } from '@/lib/automations/steps-tree';
import {
  validateStepsForActivation,
  validateTriggerForActivation,
} from '@/lib/automations/validate';

export async function GET(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'automations:read');
    const { data, error } = await ctx.supabase
      .from('automations')
      .select('*')
      .eq('account_id', ctx.accountId)
      .order('created_at', { ascending: false });
    if (error) {
      console.error('[api/v1/automations] list error:', error);
      return fail('internal', 'Failed to list automations', 500);
    }
    return okList(data ?? [], null);
  } catch (err) {
    return toApiErrorResponse(err);
  }
}

interface CreateBody {
  name?: string;
  description?: string | null;
  trigger_type?: string;
  trigger_config?: Record<string, unknown>;
  is_active?: boolean;
  steps?: BuilderStepInput[];
  template?: string;
}

export async function POST(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'automations:write');

    const body = (await request.json().catch(() => null)) as CreateBody | null;
    if (!body || typeof body !== 'object') {
      return fail('bad_request', 'Request body must be a JSON object', 400);
    }

    let effectiveSteps = body.steps;
    let effectiveName = body.name;
    let effectiveDescription = body.description;
    let effectiveTriggerType = body.trigger_type;
    let effectiveTriggerConfig = body.trigger_config;

    const templateSlug = body.template as TemplateSlug | undefined;
    if (templateSlug && (!body.steps || body.steps.length === 0) && getTemplate(templateSlug)) {
      // Resolved through messages/*.json — an MCP-created automation
      // has no client-side builder in between to review the seeded
      // copy, so it must already be in the app's locale (same
      // reasoning as the dashboard's own template-clone shortcut).
      const tTemplate = await loadServerTemplateTranslator(templateSlug);
      const t = resolveAutomationTemplate(templateSlug, tTemplate);
      effectiveName = effectiveName ?? t.name;
      effectiveDescription = effectiveDescription ?? t.description;
      effectiveTriggerType = effectiveTriggerType ?? t.trigger_type;
      effectiveTriggerConfig =
        effectiveTriggerConfig ?? (t.trigger_config as unknown as Record<string, unknown>);
      effectiveSteps = t.steps as unknown as BuilderStepInput[];
    }

    if (!effectiveName || !effectiveTriggerType) {
      return fail('bad_request', "'name' and 'trigger_type' are required (or a valid 'template')", 400);
    }

    // Block activation of a clearly broken automation up-front — same
    // gate the dashboard builder enforces — instead of letting every
    // trigger silently produce a failed log row.
    if (body.is_active) {
      const issues = [
        ...validateTriggerForActivation(effectiveTriggerType, effectiveTriggerConfig ?? {}),
        ...validateStepsForActivation(
          (effectiveSteps ?? []) as unknown as { step_type: string; step_config: Record<string, unknown> }[],
        ),
      ];
      if (issues.length > 0) {
        return fail('bad_request', 'Cannot activate automation with invalid configuration', 400);
      }
    }

    const userId = await resolveAuditUserId(ctx.supabase, ctx.accountId);

    const { data: automation, error: insertErr } = await ctx.supabase
      .from('automations')
      .insert({
        user_id: userId,
        account_id: ctx.accountId,
        name: effectiveName,
        description: effectiveDescription ?? null,
        trigger_type: effectiveTriggerType,
        trigger_config: effectiveTriggerConfig ?? {},
        is_active: !!body.is_active,
      })
      .select()
      .single();

    if (insertErr || !automation) {
      console.error('[api/v1/automations] insert error:', insertErr);
      return fail('internal', 'Failed to create automation', 500);
    }

    if (effectiveSteps && effectiveSteps.length > 0) {
      const stepErr = await insertSteps(automation.id, effectiveSteps);
      if (stepErr) {
        console.error('[api/v1/automations] step insert error:', stepErr);
        return fail('internal', 'Automation created, but its steps failed to save', 500);
      }
    }

    return ok(automation, 201);
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
