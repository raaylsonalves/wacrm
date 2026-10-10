import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import { pingDatabase } from '@/lib/health/db';

// Public liveness probe: the dashboard's outage banner polls it, and an
// external uptime monitor can alert on it. Reveals nothing but up/down and
// latency.
export const dynamic = 'force-dynamic';

export async function GET() {
  const db = await pingDatabase(supabaseAdmin());
  return NextResponse.json(
    { status: db.ok ? 'ok' : 'degraded', database: { ok: db.ok, ms: db.ms } },
    { status: db.ok ? 200 : 503, headers: { 'Cache-Control': 'no-store' } }
  );
}
