// ============================================================
// /api/settings/channel-routing — per-channel responsible agents
// (specs/channel-routing-responsibles.md).
//
//   GET    — every channel on the account (Cloud API slot + each WAHA
//            channel) with its current policy state. Any member can
//            read this (assign dropdowns need it to filter options),
//            same "read is open, write is admin+" split members/route.ts
//            uses.
//   PUT    — replace the responsible set for one channel. Creates the
//            policy row if it doesn't exist yet. An empty `user_ids`
//            array is a valid, meaningful state (restricted_empty),
//            not treated as "clear the policy" — use DELETE for that.
//   DELETE — remove the policy for one channel entirely, back to
//            unrestricted. `?channel_id=` omitted or empty means the
//            Cloud API slot.
// ============================================================

import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { loadChannelRoutingPolicies } from '@/lib/channels/routing';

function bad(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A channel key from the client: a WAHA channel uuid, `cfg:<uuid>` for an
 * official number (migration 118), or empty for the legacy account-wide
 * Cloud API slot.
 */
function parseChannelKey(raw: unknown):
  | { kind: 'waha'; id: string }
  | { kind: 'official'; id: string }
  | { kind: 'cloud' }
  | null {
  if (typeof raw !== 'string' || !raw.trim()) return { kind: 'cloud' };
  const v = raw.trim();
  if (v.startsWith('cfg:')) {
    const id = v.slice(4);
    return UUID_RE.test(id) ? { kind: 'official', id } : null;
  }
  return UUID_RE.test(v) ? { kind: 'waha', id: v } : null;
}

export async function GET() {
  try {
    const ctx = await requireRole('viewer');

    const { data: wahaChannels, error: channelsError } = await ctx.supabase
      .from('whatsapp_waha_channels')
      .select('id, label')
      .eq('account_id', ctx.accountId)
      .order('label');
    if (channelsError) {
      console.error(
        '[channel-routing GET] channels fetch error:',
        channelsError
      );
      return NextResponse.json(
        { error: 'Failed to load channels' },
        { status: 500 }
      );
    }

    const policies = await loadChannelRoutingPolicies(
      ctx.supabase,
      ctx.accountId
    );
    const byChannel = new Map(
      policies.map((p) => [p.channelId, p.responsibleUserIds])
    );

    // One slot per official number (migration 118); the legacy single
    // Cloud API slot only when the account has no official number yet.
    const { data: official } = await ctx.supabase
      .from('whatsapp_config')
      .select('id, label, display_phone_number, phone_number_id, is_primary')
      .eq('account_id', ctx.accountId)
      .order('is_primary', { ascending: false })
      .order('created_at', { ascending: true });
    const officialSlots =
      (official ?? []).length > 0
        ? (official ?? []).map((n) => {
            const key = `cfg:${n.id as string}`;
            return {
              channelId: key as string | null,
              // A single number keeps the translated "Official API" label.
              label:
                (official ?? []).length === 1
                  ? 'cloud_api'
                  : ((n.label as string | null) ||
                    (n.display_phone_number as string | null) ||
                    (n.phone_number_id as string)),
              restricted: byChannel.has(key),
              responsibleUserIds: byChannel.get(key) ?? [],
            };
          })
        : [
            {
              channelId: null as string | null,
              label: 'cloud_api', // resolved to a translated label client-side
              restricted: byChannel.has(null),
              responsibleUserIds: byChannel.get(null) ?? [],
            },
          ];

    const channels = [
      ...officialSlots,
      ...(wahaChannels ?? []).map((c) => ({
        channelId: c.id,
        label: c.label,
        restricted: byChannel.has(c.id),
        responsibleUserIds: byChannel.get(c.id) ?? [],
      })),
    ];

    return NextResponse.json({ channels });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PUT(request: Request) {
  try {
    const ctx = await requireRole('admin');

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') return bad('Invalid request body');

    const key = parseChannelKey(body.channel_id);
    if (!key) return bad('channel_id is not a valid channel');
    const channelId =
      key.kind === 'cloud' ? null : key.kind === 'official' ? `cfg:${key.id}` : key.id;
    const userIds = Array.isArray(body.user_ids)
      ? body.user_ids.filter(
          (id: unknown): id is string => typeof id === 'string'
        )
      : null;
    if (userIds === null) return bad('user_ids must be an array of strings');

    if (key.kind === 'waha') {
      const { data: channel } = await ctx.supabase
        .from('whatsapp_waha_channels')
        .select('id')
        .eq('id', key.id)
        .eq('account_id', ctx.accountId)
        .maybeSingle();
      if (!channel)
        return bad('channel_id must be a WAHA channel on this account');
    }
    if (key.kind === 'official') {
      const { data: number } = await ctx.supabase
        .from('whatsapp_config')
        .select('id')
        .eq('id', key.id)
        .eq('account_id', ctx.accountId)
        .maybeSingle();
      if (!number)
        return bad('channel_id must be an official number on this account');
    }

    if (userIds.length > 0) {
      const { data: members } = await ctx.supabase
        .from('profiles')
        .select('user_id')
        .eq('account_id', ctx.accountId)
        .in('user_id', userIds);
      if (!members || members.length !== userIds.length) {
        return bad('user_ids must all be members of this account');
      }
    }

    let query = ctx.supabase
      .from('channel_routing_policies')
      .select('id')
      .eq('account_id', ctx.accountId);
    query =
      key.kind === 'waha'
        ? query.eq('waha_channel_id', key.id)
        : key.kind === 'official'
          ? query.eq('whatsapp_config_id', key.id)
          : query.is('waha_channel_id', null).is('whatsapp_config_id', null);
    const { data: existing } = await query.maybeSingle();

    let policyId = existing?.id as string | undefined;
    if (!policyId) {
      const { data: created, error: createError } = await ctx.supabase
        .from('channel_routing_policies')
        .insert({
          account_id: ctx.accountId,
          waha_channel_id: key.kind === 'waha' ? key.id : null,
          whatsapp_config_id: key.kind === 'official' ? key.id : null,
        })
        .select('id')
        .single();
      if (createError || !created) {
        console.error(
          '[channel-routing PUT] policy insert error:',
          createError
        );
        return NextResponse.json(
          { error: 'Failed to save policy' },
          { status: 500 }
        );
      }
      policyId = created.id;
    }

    // Replace-all rather than diff — the responsible list is small
    // (account members), so a delete + reinsert is simpler than
    // computing an add/remove set and just as correct.
    await ctx.supabase
      .from('channel_routing_responsibles')
      .delete()
      .eq('policy_id', policyId);
    if (userIds.length > 0) {
      const { error: insertError } = await ctx.supabase
        .from('channel_routing_responsibles')
        .insert(
          userIds.map((userId: string) => ({
            policy_id: policyId,
            user_id: userId,
          }))
        );
      if (insertError) {
        console.error(
          '[channel-routing PUT] responsibles insert error:',
          insertError
        );
        return NextResponse.json(
          { error: 'Failed to save responsibles' },
          { status: 500 }
        );
      }
    }

    return NextResponse.json({
      channelId,
      restricted: true,
      responsibleUserIds: userIds,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(request: Request) {
  try {
    const ctx = await requireRole('admin');

    const { searchParams } = new URL(request.url);
    const key = parseChannelKey(searchParams.get('channel_id'));
    if (!key) return bad('channel_id is not a valid channel');
    const channelId =
      key.kind === 'cloud' ? null : key.kind === 'official' ? `cfg:${key.id}` : key.id;

    let query = ctx.supabase
      .from('channel_routing_policies')
      .delete()
      .eq('account_id', ctx.accountId);
    query =
      key.kind === 'waha'
        ? query.eq('waha_channel_id', key.id)
        : key.kind === 'official'
          ? query.eq('whatsapp_config_id', key.id)
          : query.is('waha_channel_id', null).is('whatsapp_config_id', null);
    const { error } = await query;
    if (error) {
      console.error('[channel-routing DELETE] error:', error);
      return NextResponse.json(
        { error: 'Failed to remove policy' },
        { status: 500 }
      );
    }

    return NextResponse.json({
      channelId,
      restricted: false,
      responsibleUserIds: [],
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
