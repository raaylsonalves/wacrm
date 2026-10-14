import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import { audit } from '@/lib/audit';
import { encrypt } from '@/lib/whatsapp/encryption';
import {
  createScaleClient,
  SCALE_DEFAULT_BASE_URL,
  ScaleError,
} from '@/lib/scheduling/scale';

/**
 * /api/integrations/scale — the account's link to the ScaLE booking
 * system (migration 130). With it on, the AI agenda tools book there
 * instead of in wacrm's own calendar (for agents with the agenda on).
 *
 * GET    (viewer+) { connected, enabled, label, last_error } — never the key.
 * POST   (admin+)  { api_key } — checked against GET /unidades first, then
 *        stored encrypted. Replaces a previous key.
 * PATCH  (admin+)  { enabled }
 * DELETE (admin+)  forget the key; the AI goes back to the own calendar.
 */
export async function GET() {
  try {
    const { supabase, accountId } = await requireRole('viewer');
    const { data } = await supabase
      .from('scheduling_integrations')
      .select('provider, enabled, label, last_error, updated_at')
      .eq('account_id', accountId)
      .maybeSingle();
    return NextResponse.json({
      connected: !!data,
      enabled: !!data?.enabled,
      label: data?.label ?? null,
      last_error: data?.last_error ?? null,
      updated_at: data?.updated_at ?? null,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const { accountId, userId } = await requireRole('admin');
    const body = (await request.json().catch(() => null)) as {
      api_key?: unknown;
    } | null;
    const apiKey = typeof body?.api_key === 'string' ? body.api_key.trim() : '';
    if (apiKey.length < 16 || apiKey.length > 200 || /\s/.test(apiKey)) {
      return NextResponse.json({ error: 'invalid_key' }, { status: 400 });
    }

    // Prove the key before keeping it: an invalid one would only surface
    // later as the AI failing in front of a customer.
    let label: string;
    try {
      const units = await createScaleClient(
        apiKey,
        SCALE_DEFAULT_BASE_URL
      ).units();
      label =
        units
          .map((u) => u.nome)
          .join(', ')
          .slice(0, 200) || 'ScaLE';
    } catch (err) {
      const code = err instanceof ScaleError ? err.codigo : 'unreachable';
      return NextResponse.json(
        { error: 'key_rejected', code },
        { status: 400 }
      );
    }

    const { error } = await supabaseAdmin()
      .from('scheduling_integrations')
      .upsert(
        {
          account_id: accountId,
          provider: 'scale',
          api_key_enc: encrypt(apiKey),
          base_url: SCALE_DEFAULT_BASE_URL,
          enabled: true,
          label,
          last_error: null,
          created_by: userId,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'account_id' }
      );
    if (error) {
      console.error('[integrations/scale] save failed:', error.message);
      return NextResponse.json({ error: 'save_failed' }, { status: 500 });
    }
    void audit({
      accountId,
      actorUserId: userId,
      action: 'integration.scale_connected',
      resourceType: 'account',
      resourceId: accountId,
      metadata: { label },
    });
    return NextResponse.json({ ok: true, label });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PATCH(request: Request) {
  try {
    const { accountId } = await requireRole('admin');
    const body = (await request.json().catch(() => null)) as {
      enabled?: unknown;
    } | null;
    if (typeof body?.enabled !== 'boolean') {
      return NextResponse.json(
        { error: 'enabled must be a boolean' },
        { status: 400 }
      );
    }
    const { error } = await supabaseAdmin()
      .from('scheduling_integrations')
      .update({ enabled: body.enabled, updated_at: new Date().toISOString() })
      .eq('account_id', accountId);
    if (error)
      return NextResponse.json({ error: 'save_failed' }, { status: 500 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE() {
  try {
    const { accountId, userId } = await requireRole('admin');
    await supabaseAdmin()
      .from('scheduling_integrations')
      .delete()
      .eq('account_id', accountId);
    void audit({
      accountId,
      actorUserId: userId,
      action: 'integration.scale_disconnected',
      resourceType: 'account',
      resourceId: accountId,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
