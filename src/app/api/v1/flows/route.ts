// ============================================================
// GET  /api/v1/flows  — list the account's flows (scope: flows:read)
// POST /api/v1/flows  — create a flow (scope: flows:write)
//
// Create supports two paths: `template_slug` (clone a quick-start
// template's trigger + node graph — the recommended path for an MCP
// client, since it produces something immediately activatable) or a
// plain `{ name, trigger_type }` empty draft. Building a fully custom
// node graph over the API isn't supported yet — flows are a stateful
// per-contact conversation graph (CLAUDE.md's "Automations vs Flows"
// section), and arbitrary node/edge authoring needs its own
// validation pass before it's safe to expose to an API caller.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, okList, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { resolveAuditUserId } from '@/lib/api/v1/contacts';
import {
  getFlowTemplate,
  loadServerFlowTemplateTranslator,
  resolveFlowTemplate,
} from '@/lib/flows/templates';

export async function GET(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'flows:read');
    const { data, error } = await ctx.supabase
      .from('flows')
      .select('*')
      .eq('account_id', ctx.accountId)
      .order('created_at', { ascending: false });
    if (error) {
      console.error('[api/v1/flows] list error:', error);
      return fail('internal', 'Failed to list flows', 500);
    }
    return okList(data ?? [], null);
  } catch (err) {
    return toApiErrorResponse(err);
  }
}

interface CreateBody {
  name?: string;
  trigger_type?: 'keyword' | 'first_inbound_message' | 'manual';
  template_slug?: string;
}

export async function POST(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'flows:write');
    const userId = await resolveAuditUserId(ctx.supabase, ctx.accountId);

    const body = (await request.json().catch(() => null)) as CreateBody | null;
    if (!body || typeof body !== 'object') {
      return fail('bad_request', 'Request body must be a JSON object', 400);
    }

    // -------- Template clone path --------
    if (body.template_slug) {
      const rawTemplate = getFlowTemplate(body.template_slug);
      if (!rawTemplate) {
        return fail('bad_request', `Unknown template_slug "${body.template_slug}"`, 400);
      }
      // Resolved through messages/*.json — same reasoning as the
      // dashboard's own template-clone shortcut: there's no builder in
      // between to review the seeded copy before a customer sees it.
      const tTemplate = await loadServerFlowTemplateTranslator(body.template_slug);
      const template = resolveFlowTemplate(body.template_slug, tTemplate);

      const { data: flow, error: flowErr } = await ctx.supabase
        .from('flows')
        .insert({
          user_id: userId,
          account_id: ctx.accountId,
          name: body.name?.trim() || template.name,
          description: template.description,
          status: 'draft',
          trigger_type: template.trigger_type,
          trigger_config: template.trigger_config,
          entry_node_id: template.entry_node_id,
        })
        .select()
        .single();
      if (flowErr || !flow) {
        console.error('[api/v1/flows] insert error:', flowErr);
        return fail('internal', 'Failed to create flow', 500);
      }

      if (template.nodes.length > 0) {
        const { error: nodesErr } = await ctx.supabase.from('flow_nodes').insert(
          template.nodes.map((n) => ({
            flow_id: flow.id,
            node_key: n.node_key,
            node_type: n.node_type,
            config: n.config,
          })),
        );
        if (nodesErr) {
          // Roll back the parent flow so a half-cloned template doesn't
          // sit as an empty draft. CASCADE on flow_id removes the
          // (probably zero) nodes too.
          await ctx.supabase.from('flows').delete().eq('id', flow.id);
          console.error('[api/v1/flows] node insert error:', nodesErr);
          return fail('internal', 'Failed to create flow nodes', 500);
        }
      }
      return ok(flow, 201);
    }

    // -------- Plain (empty) create path --------
    if (!body.name?.trim()) {
      return fail('bad_request', "'name' is required (or a valid 'template_slug')", 400);
    }
    const { data: flow, error } = await ctx.supabase
      .from('flows')
      .insert({
        user_id: userId,
        account_id: ctx.accountId,
        name: body.name.trim(),
        status: 'draft',
        trigger_type: body.trigger_type ?? 'keyword',
      })
      .select()
      .single();
    if (error || !flow) {
      console.error('[api/v1/flows] insert error:', error);
      return fail('internal', 'Failed to create flow', 500);
    }
    return ok(flow, 201);
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
