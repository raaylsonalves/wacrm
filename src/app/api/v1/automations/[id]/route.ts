import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import {
  validateStepsForActivation,
  validateTriggerForActivation,
} from '@/lib/automations/validate';

interface UpdateAutomationBody {
  name?: string;
  description?: string | null;
  trigger_type?: string;
  trigger_config?: Record<string, unknown>;
  is_active?: boolean;
}

/**
 * PATCH /api/v1/automations/:id — update name, description, trigger, or
 * active state. Intentionally narrower than the dashboard PATCH route:
 * MCP callers cannot touch `steps` here, same reasoning as flows/:id not
 * allowing node mutation — the step tree has no builder validation layer
 * on this side to catch a malformed branch structure.
 */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireApiKey(request, 'automations:write');
    const { id } = await context.params;
    const body = (await request.json().catch(() => null)) as UpdateAutomationBody | null;

    if (!body || typeof body !== 'object') {
      return fail('bad_request', 'Request body must be a JSON object', 400);
    }
    if (body.name !== undefined && !body.name.trim()) {
      return fail('bad_request', 'name cannot be empty', 400);
    }

    const { data: current, error: readError } = await ctx.supabase
      .from('automations')
      .select('id, is_active, name, description, trigger_type, trigger_config')
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .maybeSingle();
    if (readError) {
      console.error('[api/v1/automations/:id] read error:', readError);
      return fail('internal', 'Failed to load automation', 500);
    }
    if (!current) return fail('not_found', 'Automation not found', 404);

    const patch: Record<string, unknown> = {};
    if (body.name !== undefined) patch.name = body.name.trim();
    if (body.description !== undefined) patch.description = body.description;
    if (body.trigger_type !== undefined) patch.trigger_type = body.trigger_type;
    if (body.trigger_config !== undefined) patch.trigger_config = body.trigger_config;
    if (body.is_active !== undefined) patch.is_active = body.is_active;

    const willBeActive =
      typeof patch.is_active === 'boolean' ? patch.is_active : current.is_active;
    if (willBeActive) {
      const mergedTriggerType = (patch.trigger_type ?? current.trigger_type) as string;
      const mergedTriggerConfig = patch.trigger_config ?? current.trigger_config ?? {};
      const { data: steps, error: stepsError } = await ctx.supabase
        .from('automation_steps')
        .select('step_type, step_config')
        .eq('automation_id', id);
      if (stepsError) {
        console.error('[api/v1/automations/:id] steps read error:', stepsError);
        return fail('internal', 'Failed to validate automation', 500);
      }
      const issues = [
        ...validateTriggerForActivation(mergedTriggerType, mergedTriggerConfig),
        ...validateStepsForActivation(steps ?? []),
      ];
      if (issues.length > 0) {
        return fail(
          'validation_error',
          `Cannot keep automation active with invalid configuration: ${issues
            .map((issue) => issue.message)
            .join('; ')}`,
          422,
        );
      }
    }

    if (Object.keys(patch).length === 0) {
      return ok(current);
    }

    const { data: automation, error } = await ctx.supabase
      .from('automations')
      .update(patch)
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .select()
      .single();
    if (error || !automation) {
      console.error('[api/v1/automations/:id] update error:', error);
      return fail('internal', 'Failed to update automation', 500);
    }
    return ok(automation);
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
