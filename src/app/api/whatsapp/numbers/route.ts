// ============================================================
// /api/whatsapp/numbers — the account's official (Meta Cloud API)
// numbers, specs/multi-official-numbers.md.
//
//   GET    list them (no secrets: never the token)
//   PATCH  { id, primary: true }   make that number the primary
//          { id, label }           rename it
//
// Adding, editing credentials and removing a number go through
// /api/whatsapp/config (?id= / { add: true }), which verifies with Meta.
// ============================================================

import { NextResponse } from 'next/server';
import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount();
    const { data, error } = await supabase
      .from('whatsapp_config')
      .select(
        'id, label, phone_number_id, display_phone_number, waba_id, is_primary, status, registered_at, last_registration_error, created_at'
      )
      .eq('account_id', accountId)
      .order('is_primary', { ascending: false })
      .order('created_at', { ascending: true });
    if (error) throw error;
    return NextResponse.json({ numbers: data ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PATCH(request: Request) {
  try {
    const { supabase, accountId } = await requireRole('admin');
    const body = (await request.json().catch(() => null)) as {
      id?: unknown;
      primary?: unknown;
      label?: unknown;
    } | null;
    const id =
      typeof body?.id === 'string' && UUID_RE.test(body.id) ? body.id : null;
    if (!id) {
      return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
    }

    const { data: row } = await supabase
      .from('whatsapp_config')
      .select('id')
      .eq('id', id)
      .eq('account_id', accountId)
      .maybeSingle();
    if (!row) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }

    if (body?.primary === true) {
      // One transaction (migration 113): never an instant without a primary.
      const { error } = await supabase.rpc('set_primary_whatsapp_number', {
        p_config_id: id,
      });
      if (error) throw error;
    }

    if (typeof body?.label === 'string') {
      const label = body.label.trim().slice(0, 60) || null;
      const { error } = await supabase
        .from('whatsapp_config')
        .update({ label })
        .eq('id', id)
        .eq('account_id', accountId);
      if (error) throw error;
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
