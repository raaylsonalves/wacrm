import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import { audit } from '@/lib/audit';
import {
  googleCalendarEnabled,
  revokeToken,
} from '@/lib/google-calendar/google-api';

/**
 * /api/integrations/google-calendar — the account's shared calendar link.
 *
 * GET    (viewer+) { enabled, connection } — enabled = the deployment has
 *        Google OAuth env vars; the connection never includes the token.
 * PATCH  (admin+)  { include_customer_phone }
 * DELETE (admin+)  revoke with Google and stop syncing. Events already in
 *        Google stay there (the owner's calendar is theirs).
 */
export async function GET() {
  try {
    const { supabase, accountId } = await requireRole('viewer');
    if (!(await googleCalendarEnabled()))
      return NextResponse.json({ enabled: false, connection: null });
    const { data } = await supabase
      .from('calendar_connections')
      .select(
        'id, google_email, status, last_synced_at, last_error, include_customer_phone'
      )
      .eq('account_id', accountId)
      .is('user_id', null)
      .maybeSingle();
    return NextResponse.json({ enabled: true, connection: data ?? null });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PATCH(request: Request) {
  try {
    const { accountId } = await requireRole('admin');
    const body = (await request.json().catch(() => null)) as {
      include_customer_phone?: unknown;
    } | null;
    if (typeof body?.include_customer_phone !== 'boolean') {
      return NextResponse.json(
        { error: 'include_customer_phone must be a boolean' },
        { status: 400 }
      );
    }
    const { error } = await supabaseAdmin()
      .from('calendar_connections')
      .update({ include_customer_phone: body.include_customer_phone })
      .eq('account_id', accountId)
      .is('user_id', null);
    if (error)
      return NextResponse.json({ error: 'Failed to save' }, { status: 500 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE() {
  try {
    const { accountId, userId } = await requireRole('admin');
    const db = supabaseAdmin();
    const { data: conn } = await db
      .from('calendar_connections')
      .select('id, refresh_token_enc')
      .eq('account_id', accountId)
      .is('user_id', null)
      .maybeSingle();
    if (!conn) return NextResponse.json({ ok: true });
    await revokeToken(conn.refresh_token_enc as string);
    await db.from('calendar_connections').delete().eq('id', conn.id);
    await db.from('calendar_sync_outbox').delete().eq('account_id', accountId);
    void audit({
      accountId,
      actorUserId: userId,
      action: 'calendar.disconnected',
      resourceType: 'calendar_connection',
      resourceId: conn.id as string,
      metadata: { provider: 'google' },
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
