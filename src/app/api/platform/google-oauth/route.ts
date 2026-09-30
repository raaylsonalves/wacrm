import { NextResponse } from 'next/server';
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import { encrypt } from '@/lib/whatsapp/encryption';
import { audit } from '@/lib/audit';
import {
  loadGoogleClient,
  redirectUri,
} from '@/lib/google-calendar/google-api';

/**
 * /api/platform/google-oauth — the installation's Google OAuth app
 * (migration 097). Agency owner only: the credential serves every account,
 * so a client admin must never be able to swap it.
 *
 * GET    { source: 'env'|'database'|null, client_id, redirect_uri }
 *        — the secret is never returned.
 * PUT    { client_id, client_secret }
 * DELETE removes the stored credential (env vars, if set, still apply).
 */
async function requireAgencyOwner() {
  const ctx = await getCurrentAccount();
  const { data } = await ctx.supabase.rpc('agency_home_if_owner');
  if (!data) return null;
  return ctx;
}

const forbidden = () =>
  NextResponse.json({ error: 'Forbidden' }, { status: 403 });

export async function GET(request: Request) {
  try {
    const ctx = await requireAgencyOwner();
    if (!ctx) return forbidden();
    const c = await loadGoogleClient();
    return NextResponse.json({
      source: c?.source ?? null,
      client_id: c?.id ?? null,
      redirect_uri: redirectUri(new URL(request.url).origin),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PUT(request: Request) {
  try {
    const ctx = await requireAgencyOwner();
    if (!ctx) return forbidden();
    const body = (await request.json().catch(() => null)) as {
      client_id?: unknown;
      client_secret?: unknown;
    } | null;
    const clientId =
      typeof body?.client_id === 'string' ? body.client_id.trim() : '';
    const secret =
      typeof body?.client_secret === 'string' ? body.client_secret.trim() : '';
    if (!/^[\w-]+\.apps\.googleusercontent\.com$/.test(clientId)) {
      return NextResponse.json({ error: 'invalid_client_id' }, { status: 400 });
    }
    if (secret.length < 10 || secret.length > 200) {
      return NextResponse.json({ error: 'invalid_secret' }, { status: 400 });
    }
    const { error } = await supabaseAdmin()
      .from('platform_google_oauth')
      .upsert({
        id: true,
        client_id: clientId,
        client_secret_enc: encrypt(secret),
        updated_by: ctx.userId,
        updated_at: new Date().toISOString(),
      });
    if (error)
      return NextResponse.json({ error: 'save_failed' }, { status: 500 });
    void audit({
      accountId: ctx.accountId,
      actorUserId: ctx.userId,
      action: 'platform.google_oauth_updated',
      resourceType: 'platform',
      metadata: { client_id: clientId },
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE() {
  try {
    const ctx = await requireAgencyOwner();
    if (!ctx) return forbidden();
    await supabaseAdmin().from('platform_google_oauth').delete().eq('id', true);
    void audit({
      accountId: ctx.accountId,
      actorUserId: ctx.userId,
      action: 'platform.google_oauth_removed',
      resourceType: 'platform',
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
