// GET /api/platform/me — is the signed-in user a platform admin? Lets the
// UI decide whether to show platform-only tabs without loading their data.

import { NextResponse } from 'next/server';
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { isPlatformAdmin } from '@/lib/platform/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const ctx = await getCurrentAccount({ allowUnpaid: true });
    return NextResponse.json({
      platformAdmin: await isPlatformAdmin(ctx.userId),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
