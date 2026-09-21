import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { validateFlowForActivation } from '@/lib/flows/validate';

interface UpdateFlowBody {
  name?: string;
  trigger_type?: 'keyword' | 'first_inbound_message' | 'manual';
  trigger_config?: Record<string, unknown>;
}

/**
 * PATCH /api/v1/flows/:id — update the flow trigger without replacing its
 * conversation graph. This is intentionally narrower than the dashboard PUT
 * route: MCP callers cannot mutate nodes through this endpoint.
 */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireApiKey(request, 'flows:write');
    const { id } = await context.params;
    const body = (await request.json().catch(() => null)) as UpdateFlowBody | null;

    if (!body || typeof body !== 'object') {
      return fail('bad_request', 'Request body must be a JSON object', 400);
    }
    if (body.name !== undefined && !body.name.trim()) {
      return fail('bad_request', 'name cannot be empty', 400);
    }

    const { data: current, error: readError } = await ctx.supabase
      .from('flows')
      .select('id, status, name, trigger_type, trigger_config, entry_node_id')
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .maybeSingle();
    if (readError) {
      console.error('[api/v1/flows/:id] read error:', readError);
      return fail('internal', 'Failed to load flow', 500);
    }
    if (!current) return fail('not_found', 'Flow not found', 404);

    const nextTriggerType = body.trigger_type ?? current.trigger_type;
    const nextTriggerConfig = body.trigger_config ?? current.trigger_config ?? {};

    // Active flows must remain valid after a trigger change. The graph is
    // read-only here, so validation can safely use the existing nodes.
    if (current.status === 'active') {
      const { data: nodes, error: nodesError } = await ctx.supabase
        .from('flow_nodes')
        .select('node_key, node_type, config')
        .eq('flow_id', id);
      if (nodesError) {
        console.error('[api/v1/flows/:id] nodes read error:', nodesError);
        return fail('internal', 'Failed to validate flow', 500);
      }
      const issues = validateFlowForActivation(
        {
          name: body.name?.trim() ?? current.name,
          trigger_type: nextTriggerType,
          trigger_config: nextTriggerConfig,
          entry_node_id: body.trigger_type !== undefined || body.trigger_config !== undefined
            ? current.entry_node_id
            : current.entry_node_id,
        },
        nodes ?? [],
      );
      const blockers = issues.filter((issue) => issue.severity === 'error');
      if (blockers.length > 0) {
        return fail(
          'validation_error',
          `Active flow is invalid after this update: ${blockers.map((issue) => issue.message).join('; ')}`,
          422,
        );
      }
    }

    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (body.name !== undefined) patch.name = body.name.trim();
    if (body.trigger_type !== undefined) patch.trigger_type = body.trigger_type;
    if (body.trigger_config !== undefined) patch.trigger_config = body.trigger_config;

    const { data: flow, error } = await ctx.supabase
      .from('flows')
      .update(patch)
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .select()
      .single();
    if (error || !flow) {
      console.error('[api/v1/flows/:id] update error:', error);
      return fail('internal', 'Failed to update flow', 500);
    }
    return ok(flow);
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
