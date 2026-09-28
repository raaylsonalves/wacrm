// ============================================================
// PUT /api/ai/routers/[id]/members — replace a router's whole intent
// list in one call (specs/multi-agent-router.md). Simpler than
// per-member CRUD for what's really one small ordered table the
// router-builder screen edits as a unit; `position` is just the
// array index, so reordering is "send the array in the new order."
// ============================================================

import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

interface RawMember {
  agent_id?: unknown;
  intent_name?: unknown;
  intent_description?: unknown;
  examples?: unknown;
}

function bad(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin');
    const { id } = await params;

    const limit = checkRateLimit(
      `ai-router-members:${userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { data: router } = await supabase
      .from('ai_routers')
      .select('id')
      .eq('id', id)
      .eq('account_id', accountId)
      .maybeSingle();
    if (!router)
      return NextResponse.json({ error: 'Router not found' }, { status: 404 });

    const body = await request.json().catch(() => null);
    const raw = body?.members;
    if (!Array.isArray(raw)) return bad('members must be an array');

    const agentIds = new Set<string>();
    const rows: {
      router_id: string;
      agent_id: string;
      intent_name: string;
      intent_description: string;
      examples: string[];
      position: number;
    }[] = [];

    for (let i = 0; i < raw.length; i++) {
      const m = raw[i] as RawMember;
      const agentId = typeof m.agent_id === 'string' ? m.agent_id : '';
      const intentName =
        typeof m.intent_name === 'string' ? m.intent_name.trim() : '';
      const intentDescription =
        typeof m.intent_description === 'string'
          ? m.intent_description.trim()
          : '';
      if (!agentId) return bad(`members[${i}].agent_id is required`);
      if (!intentName) return bad(`members[${i}].intent_name is required`);
      if (!intentDescription)
        return bad(`members[${i}].intent_description is required`);
      agentIds.add(agentId);
      rows.push({
        router_id: id,
        agent_id: agentId,
        intent_name: intentName,
        intent_description: intentDescription,
        examples: Array.isArray(m.examples)
          ? m.examples.filter((e): e is string => typeof e === 'string')
          : [],
        position: i,
      });
    }

    if (agentIds.size > 0) {
      const { data: ownedAgents } = await supabase
        .from('ai_configs')
        .select('id')
        .eq('account_id', accountId)
        .in('id', Array.from(agentIds));
      const ownedIds = new Set((ownedAgents ?? []).map((a) => a.id));
      const missing = Array.from(agentIds).filter((a) => !ownedIds.has(a));
      if (missing.length > 0) {
        return bad(
          `Unknown agent id(s) for this account: ${missing.join(', ')}`
        );
      }
    }

    // Replace-all under one router — delete then insert rather than a
    // diff, since the whole list is sent every time and there's no
    // other writer of this table to race against for the same router.
    const { error: delErr } = await supabase
      .from('ai_router_members')
      .delete()
      .eq('router_id', id);
    if (delErr) {
      console.error('[ai/routers members PUT] delete error:', delErr);
      return NextResponse.json(
        { error: 'Failed to update intents' },
        { status: 500 }
      );
    }

    if (rows.length > 0) {
      const { error: insErr } = await supabase
        .from('ai_router_members')
        .insert(rows);
      if (insErr) {
        console.error('[ai/routers members PUT] insert error:', insErr);
        return NextResponse.json(
          { error: 'Failed to update intents' },
          { status: 500 }
        );
      }
    }

    return NextResponse.json({ success: true, count: rows.length });
  } catch (err) {
    return toErrorResponse(err);
  }
}
