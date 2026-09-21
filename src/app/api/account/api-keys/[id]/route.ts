// ============================================================
// PATCH  /api/account/api-keys/[id] — rename a key or change its scopes.
// DELETE /api/account/api-keys/[id] — revoke a key.
//
// PATCH never touches `key_hash`: it can't rotate the secret, only
// the name and the `scopes[]` it's authorized for. This is the
// mechanism for "I created this key with the wrong scopes" without
// having to revoke-and-reissue (which would break whatever already
// has the old plaintext configured). Admin+, enforced here and by
// the `api_keys_update` RLS policy. Effective on the next request —
// `requireApiKey` reads `scopes` fresh every time, nothing is cached.
//
// Soft revoke: sets `revoked_at` rather than deleting the row, so
// the key's name/prefix stay visible in the roster as an audit
// trail ("this key existed and was turned off") and so the auth
// path's liveness check (`findActiveKeyByHash` filters revoked
// rows) starts rejecting it immediately. Admin+, enforced here and
// by the `api_keys_update` RLS policy.
//
// Revocation is effective on the next request: once `revoked_at` is
// set, `findActiveKeyByHash` returns null and the key 401s.
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { normalizeScopes } from '@/lib/api-keys/scopes';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

const MAX_NAME_LEN = 80;

const SAFE_COLUMNS =
  'id, name, key_prefix, scopes, last_used_at, expires_at, revoked_at, created_at';

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireRole('admin');

    const limit = checkRateLimit(
      `admin:apiKeyUpdate:${ctx.userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { id } = await params;
    const body = (await request.json().catch(() => null)) as {
      name?: unknown;
      scopes?: unknown;
    } | null;

    const update: Record<string, unknown> = {};

    if (body?.name !== undefined) {
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!name) {
        return NextResponse.json(
          { error: "'name' cannot be empty" },
          { status: 400 }
        );
      }
      if (name.length > MAX_NAME_LEN) {
        return NextResponse.json(
          { error: `Name must be ${MAX_NAME_LEN} characters or fewer` },
          { status: 400 }
        );
      }
      update.name = name;
    }

    if (body?.scopes !== undefined) {
      const scopes = normalizeScopes(body.scopes);
      if (scopes === null) {
        return NextResponse.json(
          { error: "'scopes' must be an array of known scope strings" },
          { status: 400 }
        );
      }
      update.scopes = scopes;
    }

    if (Object.keys(update).length === 0) {
      return NextResponse.json(
        { error: "Nothing to update — pass 'name' and/or 'scopes'" },
        { status: 400 }
      );
    }

    // Scoped by account_id so an admin can't repoint another account's
    // key by guessing a UUID (RLS already enforces this too).
    const { data, error } = await ctx.supabase
      .from('api_keys')
      .update(update)
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .is('revoked_at', null)
      .select(SAFE_COLUMNS)
      .maybeSingle();

    if (error) {
      console.error('[PATCH /api/account/api-keys/[id]] error:', error);
      return NextResponse.json(
        { error: 'Failed to update API key' },
        { status: 500 }
      );
    }
    if (!data) {
      return NextResponse.json(
        { error: 'API key not found or already revoked' },
        { status: 404 }
      );
    }

    return NextResponse.json({ key: data });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireRole('admin');

    const limit = checkRateLimit(
      `admin:apiKeyRevoke:${ctx.userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { id } = await params;

    // Scope the update by account_id as well as id so an admin can
    // never revoke another account's key by guessing a UUID. (RLS
    // already enforces this; the explicit filter is belt-and-braces
    // and makes the "0 rows updated → 404" path precise.)
    const { data, error } = await ctx.supabase
      .from('api_keys')
      .update({ revoked_at: new Date().toISOString() })
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .is('revoked_at', null)
      .select('id')
      .maybeSingle();

    if (error) {
      console.error('[DELETE /api/account/api-keys/[id]] error:', error);
      return NextResponse.json(
        { error: 'Failed to revoke API key' },
        { status: 500 }
      );
    }
    if (!data) {
      // Either no such key in this account, or it was already revoked.
      return NextResponse.json(
        { error: 'API key not found or already revoked' },
        { status: 404 }
      );
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
