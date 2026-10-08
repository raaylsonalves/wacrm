// ============================================================
// /api/ai/agents/[id]/channels — which NUMBERS an agent answers on
// (specs/ai-agents-management.md; migration 074).
//
//   GET — every number on the account (the Cloud API slot + each WAHA
//         channel) with the agent that currently holds it, so the UI can
//         say "hoje atendido por X" before a number is moved.
//   PUT — set the numbers this agent answers on. Moving a number from
//         another agent is allowed (it is one agent per number); numbers
//         not in the list that this agent held are released.
//
// A number with no binding falls through to the router / default agent,
// exactly as before this existed. `channel_id: null` is the Cloud API
// number (the repo-wide convention).
// ============================================================

import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';
import { audit } from '@/lib/audit';

function bad(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A binding's number as one key: WAHA id, `cfg:<id>`, or 'cloud'. */
function bindingKey(channelId: string | null, configId: string | null) {
  return channelId ?? (configId ? `cfg:${configId}` : 'cloud');
}

async function loadAgent(
  supabase: Awaited<ReturnType<typeof requireRole>>['supabase'],
  accountId: string,
  id: string
) {
  const { data } = await supabase
    .from('ai_configs')
    .select('id, name, is_default')
    .eq('id', id)
    .eq('account_id', accountId)
    .maybeSingle();
  return data as { id: string; name: string; is_default: boolean } | null;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { supabase, accountId } = await requireRole('viewer');
    const { id } = await params;
    if (!UUID.test(id)) return bad('Invalid agent id');

    const agent = await loadAgent(supabase, accountId, id);
    if (!agent)
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 });

    const [{ data: waha }, { data: bindings }, { data: agents }, { data: official }] =
      await Promise.all([
        supabase
          .from('whatsapp_waha_channels')
          .select('id, label')
          .eq('account_id', accountId)
          .order('label'),
        supabase
          .from('ai_channel_agents')
          .select('channel_id, whatsapp_config_id, agent_id')
          .eq('account_id', accountId),
        supabase
          .from('ai_configs')
          .select('id, name')
          .eq('account_id', accountId),
        supabase
          .from('whatsapp_config')
          .select('id, label, display_phone_number, phone_number_id, is_primary')
          .eq('account_id', accountId)
          .order('is_primary', { ascending: false })
          .order('created_at', { ascending: true }),
      ]);

    const names = new Map((agents ?? []).map((a) => [a.id as string, a.name as string]));
    // Slot keys: a WAHA channel id, `cfg:<id>` for an official number
    // (migration 114), or 'cloud' for the legacy account-wide row.
    const holder = new Map(
      (bindings ?? []).map((b) => [
        bindingKey(
          b.channel_id as string | null,
          b.whatsapp_config_id as string | null
        ),
        b.agent_id as string,
      ])
    );

    const slot = (channelId: string | null, label: string) => {
      const holderId = holder.get(channelId ?? 'cloud') ?? null;
      return {
        channelId,
        label, // 'cloud_api' is resolved to a translated label client-side
        boundAgentId: holderId,
        boundAgentName: holderId ? (names.get(holderId) ?? null) : null,
        mine: holderId === id,
      };
    };

    return NextResponse.json({
      isDefault: agent.is_default,
      channels: [
        // One slot per official number; the legacy single slot only when
        // the account has none.
        ...((official ?? []).length > 0
          ? (official ?? []).map((n) =>
              slot(
                `cfg:${n.id as string}`,
                (official ?? []).length === 1
                  ? 'cloud_api'
                  : ((n.label as string | null) ||
                      (n.display_phone_number as string | null) ||
                      (n.phone_number_id as string))
              )
            )
          : [slot(null, 'cloud_api')]),
        ...(waha ?? []).map((c) => slot(c.id as string, c.label as string)),
      ],
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin');
    const { id } = await params;
    if (!UUID.test(id)) return bad('Invalid agent id');

    const limit = checkRateLimit(
      `ai-agent-channels:${userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const agent = await loadAgent(supabase, accountId, id);
    if (!agent)
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    // The default agent may be bound too: it still answers every number
    // nobody claims, and binding it to a number makes that explicit (and
    // lets the number keep it when another agent is added later).

    const body = await request.json().catch(() => null);
    const raw: unknown = body?.channel_ids;
    if (!Array.isArray(raw)) return bad('channel_ids must be a list');
    // Each entry: a WAHA channel uuid, `cfg:<uuid>` (official number) or
    // null / 'cloud' (the legacy account-wide official slot).
    const wanted: string[] = [];
    for (const v of raw) {
      if (v === null || v === 'cloud') wanted.push('cloud');
      else if (typeof v === 'string' && UUID.test(v)) wanted.push(v);
      else if (
        typeof v === 'string' &&
        v.startsWith('cfg:') &&
        UUID.test(v.slice(4))
      )
        wanted.push(v);
      else return bad('channel_ids holds an invalid channel id');
    }
    const wantedKeys = new Set(wanted);

    const { data: existing, error: readErr } = await supabase
      .from('ai_channel_agents')
      .select('id, channel_id, whatsapp_config_id, agent_id')
      .eq('account_id', accountId);
    if (readErr) {
      console.error('[ai/agents channels PUT] read error:', readErr);
      return NextResponse.json({ error: 'Failed to update' }, { status: 500 });
    }

    // Release: bindings this agent holds that are no longer wanted.
    const keyOfRow = (b: { channel_id: unknown; whatsapp_config_id: unknown }) =>
      bindingKey(
        b.channel_id as string | null,
        b.whatsapp_config_id as string | null
      );
    const release = (existing ?? []).filter(
      (b) => b.agent_id === id && !wantedKeys.has(keyOfRow(b))
    );
    if (release.length > 0) {
      const { error } = await supabase
        .from('ai_channel_agents')
        .delete()
        .in('id', release.map((b) => b.id as string));
      if (error) {
        console.error('[ai/agents channels PUT] release error:', error);
        return NextResponse.json({ error: 'Failed to update' }, { status: 500 });
      }
    }

    // Take: numbers held by ANOTHER agent move here (one agent per number,
    // enforced by the unique index); numbers already ours stay untouched.
    for (const key of wanted) {
      const current = (existing ?? []).find((b) => keyOfRow(b) === key);
      if (current?.agent_id === id) continue;
      if (current) {
        const { error } = await supabase
          .from('ai_channel_agents')
          .update({ agent_id: id })
          .eq('id', current.id as string);
        if (error) {
          console.error('[ai/agents channels PUT] move error:', error);
          return NextResponse.json({ error: 'Failed to update' }, { status: 500 });
        }
      } else {
        const { error } = await supabase.from('ai_channel_agents').insert({
          account_id: accountId,
          channel_id: key === 'cloud' || key.startsWith('cfg:') ? null : key,
          whatsapp_config_id: key.startsWith('cfg:') ? key.slice(4) : null,
          agent_id: id,
        });
        if (error) {
          // The scope trigger refuses a channel from another account.
          console.error('[ai/agents channels PUT] insert error:', error);
          return NextResponse.json(
            { error: 'One of the numbers could not be assigned' },
            { status: 400 }
          );
        }
      }
    }

    void audit({
      accountId,
      actorUserId: userId,
      action: 'ai_agent.channels_updated',
      resourceType: 'ai_config',
      resourceId: id,
      metadata: { name: agent.name, channels: wanted.length },
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
