// ============================================================
// /api/ai/routers/[id] — one router (specs/multi-agent-router.md).
//
//   PATCH  — update name/classifier/min_confidence/sticky/
//            fallback_agent_id, or flip is_active. Activating with no
//            members configured is rejected — an active router with
//            nothing to classify against would silently fall through
//            to the default agent forever, which looks identical to
//            "the router isn't working."
//   DELETE — removes the router and its members (cascades).
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

async function loadOwnedRouter(
  supabase: Awaited<ReturnType<typeof requireRole>>['supabase'],
  accountId: string,
  id: string
) {
  const { data, error } = await supabase
    .from('ai_routers')
    .select('*')
    .eq('id', id)
    .eq('account_id', accountId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin');
    const { id } = await params;

    const limit = checkRateLimit(
      `ai-router-update:${userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const existing = await loadOwnedRouter(supabase, accountId, id);
    if (!existing)
      return NextResponse.json({ error: 'Router not found' }, { status: 404 });

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') return bad('Invalid request body');

    const update: Record<string, unknown> = {};

    if ('name' in body) {
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!name) return bad('name cannot be empty');
      update.name = name;
    }
    if ('classifier_model' in body) {
      update.classifier_model =
        typeof body.classifier_model === 'string' &&
        body.classifier_model.trim()
          ? body.classifier_model.trim()
          : null;
    }
    if ('min_confidence' in body) {
      const v = Number(body.min_confidence);
      if (!Number.isFinite(v) || v < 0 || v > 1) {
        return bad('min_confidence must be a number between 0 and 1');
      }
      update.min_confidence = v;
    }
    if ('sticky' in body) update.sticky = body.sticky === true;
    if ('fallback_agent_id' in body) {
      const raw =
        typeof body.fallback_agent_id === 'string'
          ? body.fallback_agent_id.trim()
          : '';
      if (raw) {
        const { data: agent } = await supabase
          .from('ai_configs')
          .select('id')
          .eq('id', raw)
          .eq('account_id', accountId)
          .maybeSingle();
        if (!agent)
          return bad('fallback_agent_id must be an agent on this account');
        update.fallback_agent_id = raw;
      } else {
        update.fallback_agent_id = null;
      }
    }
    if ('is_active' in body) {
      const nextActive = body.is_active === true;
      if (nextActive) {
        const { count } = await supabase
          .from('ai_router_members')
          .select('id', { count: 'exact', head: true })
          .eq('router_id', id);
        if (!count) {
          return bad('Add at least one intent before activating this router');
        }
      }
      update.is_active = nextActive;
    }

    const { error: upErr } = await supabase
      .from('ai_routers')
      .update(update)
      .eq('id', id);
    if (upErr) {
      // idx_ai_routers_active_per_channel — another router is already
      // active on the same channel (or whole-account slot).
      if (upErr.code === '23505') {
        return bad(
          'Another router is already active for this channel — deactivate it first.'
        );
      }
      console.error('[ai/routers PATCH] update error:', upErr);
      return NextResponse.json(
        { error: 'Failed to update router' },
        { status: 500 }
      );
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { supabase, accountId } = await requireRole('admin');
    const { id } = await params;

    const existing = await loadOwnedRouter(supabase, accountId, id);
    if (!existing)
      return NextResponse.json({ error: 'Router not found' }, { status: 404 });

    const { error } = await supabase.from('ai_routers').delete().eq('id', id);
    if (error) {
      console.error('[ai/routers DELETE] error:', error);
      return NextResponse.json(
        { error: 'Failed to delete router' },
        { status: 500 }
      );
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
