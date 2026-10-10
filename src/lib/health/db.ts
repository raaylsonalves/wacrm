import type { SupabaseClient } from '@supabase/supabase-js';

export interface DbHealth {
  ok: boolean;
  ms: number;
  error?: string;
}

/**
 * One cheap round trip through the Supabase API (PostgREST → Postgres).
 * That is the path that wedged on 2026-10-10 while Postgres itself was idle,
 * so pinging Postgres directly would have said "healthy".
 */
export async function pingDatabase(
  db: SupabaseClient,
  timeoutMs = 4000
): Promise<DbHealth> {
  const started = Date.now();
  try {
    const { error } = await db
      .from('accounts')
      .select('id', { head: true, count: 'planned' })
      .limit(1)
      .abortSignal(AbortSignal.timeout(timeoutMs));
    const ms = Date.now() - started;
    return error
      ? { ok: false, ms, error: error.message || error.code || 'error' }
      : { ok: true, ms };
  } catch (err) {
    return {
      ok: false,
      ms: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// The webhook asks on every delivery; remember a healthy answer briefly so a
// burst of messages costs one ping, not one each. A failure is never cached.
const HEALTHY_TTL_MS = 10_000;
let lastHealthyAt = 0;

export async function databaseReachable(db: SupabaseClient): Promise<boolean> {
  if (Date.now() - lastHealthyAt < HEALTHY_TTL_MS) return true;
  const { ok } = await pingDatabase(db);
  if (ok) lastHealthyAt = Date.now();
  return ok;
}
