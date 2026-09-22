import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { validateFlowForActivation } from '@/lib/flows/validate';

interface UpdateFlowNodeBody {
  node_key: string;
  node_type: string;
  config: Record<string, unknown>;
  position_x?: number;
  position_y?: number;
}

interface UpdateFlowBody {
  name?: string;
  trigger_type?: 'keyword' | 'first_inbound_message' | 'manual';
  trigger_config?: Record<string, unknown>;
  entry_node_id?: string | null;
  nodes?: UpdateFlowNodeBody[];
}

/**
 * PATCH /api/v1/flows/:id — update the flow trigger, and optionally
 * replace its conversation graph (`nodes` + `entry_node_id`).
 *
 * Replacing `nodes` has no visual builder to catch a broken graph as
 * it's typed, unlike the dashboard's PUT route — so unlike that route
 * (which only validates on the transition into `active`), this one
 * always runs `validateFlowForActivation` when `nodes` is present,
 * regardless of the flow's current status. A caller building a flow
 * across several PATCH calls should expect intermediate saves to be
 * rejected if the graph isn't internally consistent yet; send the
 * whole graph in one call to avoid that.
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
    if (body.nodes !== undefined) {
      if (!Array.isArray(body.nodes)) {
        return fail('bad_request', "'nodes' must be an array", 400);
      }
      for (const [i, node] of body.nodes.entries()) {
        if (!node || typeof node !== 'object') {
          return fail('bad_request', `nodes[${i}] must be an object`, 400);
        }
        if (!node.node_key?.trim()) {
          return fail('bad_request', `nodes[${i}].node_key is required`, 400);
        }
        if (!node.node_type?.trim()) {
          return fail('bad_request', `nodes[${i}].node_type is required`, 400);
        }
        if (node.config !== undefined && typeof node.config !== 'object') {
          return fail('bad_request', `nodes[${i}].config must be an object`, 400);
        }
      }
      const keys = new Set<string>();
      for (const node of body.nodes) {
        if (keys.has(node.node_key)) {
          return fail('bad_request', `Duplicate node_key "${node.node_key}"`, 400);
        }
        keys.add(node.node_key);
      }
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
    const nextEntryNodeId =
      body.entry_node_id !== undefined ? body.entry_node_id : current.entry_node_id;

    const graphChanged = body.nodes !== undefined;
    const needsValidation = current.status === 'active' || graphChanged;
    if (needsValidation) {
      let nodesForValidation: { node_key: string; node_type: string; config: Record<string, unknown> }[];
      if (graphChanged) {
        nodesForValidation = body.nodes!.map((n) => ({
          node_key: n.node_key,
          node_type: n.node_type,
          config: n.config ?? {},
        }));
      } else {
        const { data: nodes, error: nodesError } = await ctx.supabase
          .from('flow_nodes')
          .select('node_key, node_type, config')
          .eq('flow_id', id);
        if (nodesError) {
          console.error('[api/v1/flows/:id] nodes read error:', nodesError);
          return fail('internal', 'Failed to validate flow', 500);
        }
        nodesForValidation = nodes ?? [];
      }
      const issues = validateFlowForActivation(
        {
          name: body.name?.trim() ?? current.name,
          trigger_type: nextTriggerType,
          trigger_config: nextTriggerConfig,
          entry_node_id: nextEntryNodeId,
        },
        nodesForValidation,
      );
      const blockers = issues.filter((issue) => issue.severity === 'error');
      if (blockers.length > 0) {
        return fail(
          'validation_error',
          `Flow would be invalid after this update: ${blockers.map((issue) => issue.message).join('; ')}`,
          422,
        );
      }
    }

    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (body.name !== undefined) patch.name = body.name.trim();
    if (body.trigger_type !== undefined) patch.trigger_type = body.trigger_type;
    if (body.trigger_config !== undefined) patch.trigger_config = body.trigger_config;
    if (body.entry_node_id !== undefined) patch.entry_node_id = body.entry_node_id;

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

    if (graphChanged) {
      // Delete-then-insert, same approach as the dashboard's PUT route —
      // not atomic, but the flow runner tolerates a mid-edit read
      // (node_not_found ends the run cleanly instead of crashing).
      const { error: delErr } = await ctx.supabase
        .from('flow_nodes')
        .delete()
        .eq('flow_id', id);
      if (delErr) {
        console.error('[api/v1/flows/:id] node delete error:', delErr);
        return fail('internal', 'Failed to replace flow nodes', 500);
      }
      if (body.nodes!.length > 0) {
        const { error: insErr } = await ctx.supabase.from('flow_nodes').insert(
          body.nodes!.map((n) => ({
            flow_id: id,
            node_key: n.node_key,
            node_type: n.node_type,
            config: n.config ?? {},
            position_x: n.position_x ?? 0,
            position_y: n.position_y ?? 0,
          })),
        );
        if (insErr) {
          console.error('[api/v1/flows/:id] node insert error:', insErr);
          return fail('internal', 'Failed to replace flow nodes', 500);
        }
      }
    }

    return ok(flow);
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
