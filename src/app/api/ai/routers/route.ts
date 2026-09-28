// ============================================================
// /api/ai/routers — intent routers (specs/multi-agent-router.md).
//
//   GET  — list every router on the account, with its members.
//   POST — create a router (starts inactive — `is_active` defaults
//          false in the schema, and this route doesn't accept it on
//          create; PATCH .../[id] flips it on once intents are set
//          up, so a half-configured router never goes live by
//          accident).
// ============================================================

import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

function bad(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

export async function GET() {
  try {
    const { supabase, accountId } = await requireRole('viewer');

    const { data: routers, error } = await supabase
      .from('ai_routers')
      .select(
        'id, channel_id, name, is_active, classifier_model, min_confidence, sticky, fallback_agent_id, created_at'
      )
      .eq('account_id', accountId)
      .order('created_at', { ascending: true });
    if (error) {
      console.error('[ai/routers GET] fetch error:', error);
      return NextResponse.json(
        { error: 'Failed to load routers' },
        { status: 500 }
      );
    }
    if (!routers || routers.length === 0)
      return NextResponse.json({ routers: [] });

    const { data: members } = await supabase
      .from('ai_router_members')
      .select(
        'id, router_id, agent_id, intent_name, intent_description, examples, position'
      )
      .in(
        'router_id',
        routers.map((r) => r.id)
      )
      .order('position', { ascending: true });

    const membersByRouter = new Map<string, typeof members>();
    for (const m of members ?? []) {
      const bucket = membersByRouter.get(m.router_id) ?? [];
      bucket.push(m);
      membersByRouter.set(m.router_id, bucket);
    }

    return NextResponse.json({
      routers: routers.map((r) => ({
        ...r,
        members: membersByRouter.get(r.id) ?? [],
      })),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin');

    const limit = checkRateLimit(
      `ai-router-create:${userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') return bad('Invalid request body');

    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return bad('name is required');

    const channelId =
      typeof body.channel_id === 'string' && body.channel_id.trim()
        ? body.channel_id.trim()
        : null;
    if (channelId) {
      const { data: channel } = await supabase
        .from('whatsapp_waha_channels')
        .select('id')
        .eq('id', channelId)
        .eq('account_id', accountId)
        .maybeSingle();
      if (!channel)
        return bad('channel_id must be a WAHA channel on this account');
    }

    const { data: created, error } = await supabase
      .from('ai_routers')
      .insert({
        account_id: accountId,
        channel_id: channelId,
        name,
      })
      .select(
        'id, channel_id, name, is_active, classifier_model, min_confidence, sticky, fallback_agent_id'
      )
      .single();

    if (error || !created) {
      console.error('[ai/routers POST] insert error:', error);
      return NextResponse.json(
        { error: 'Failed to create router' },
        { status: 500 }
      );
    }

    return NextResponse.json(
      { router: { ...created, members: [] } },
      { status: 201 }
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}
