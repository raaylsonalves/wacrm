// ============================================================
// Per-channel responsible agents (specs/channel-routing-responsibles.md).
//
// This is the shared read-side resolver both call sites use — the
// dashboard's assign dropdowns (via the API routes below) and, in
// principle, any future server-side assignment path. The actual
// enforcement lives in Postgres (migration 069's
// `enforce_channel_routing_assignment` trigger), because the
// dashboard writes `assigned_agent_id` straight from the browser
// through RLS with no server hop this module could intercept — this
// resolver only decides what a picker should *offer*, not what the
// database will *accept*.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

/** Sentinel key for the Cloud API slot in a policy map — NULL isn't a
 *  usable Map key when NULL is also a meaningful absence marker. */
export const CLOUD_API_POLICY_KEY = '__cloud_api__';

function policyKey(wahaChannelId: string | null): string {
  return wahaChannelId ?? CLOUD_API_POLICY_KEY;
}

/**
 * Resolve the eligible-assignee set for one conversation's channel.
 *
 * Returns `null` for "unrestricted" (no policy row — every account
 * member is eligible), or the (possibly empty) array of eligible user
 * ids otherwise. An empty array is "restricted_empty": a policy exists
 * but nobody's been assigned responsibility yet.
 */
export async function eligibleAssigneesForConversation(
  db: SupabaseClient,
  accountId: string,
  whatsappChannelId: string | null
): Promise<string[] | null> {
  let query = db
    .from('channel_routing_policies')
    .select('id')
    .eq('account_id', accountId);
  query =
    whatsappChannelId === null
      ? query.is('waha_channel_id', null)
      : query.eq('waha_channel_id', whatsappChannelId);

  const { data: policy, error: policyError } = await query.maybeSingle();
  if (policyError || !policy) return null;

  const { data: responsibles, error: responsiblesError } = await db
    .from('channel_routing_responsibles')
    .select('user_id')
    .eq('policy_id', policy.id);
  if (responsiblesError) return null;

  return (responsibles ?? []).map((r) => r.user_id as string);
}

export interface ChannelPolicyEntry {
  /** `null` = the account's Cloud API slot. */
  channelId: string | null;
  responsibleUserIds: string[];
}

/**
 * Load every configured policy on the account in two queries, for
 * callers that need to check eligibility across many conversations at
 * once (the inbox list) rather than one at a time — avoids an
 * eligibility round trip per row.
 */
export async function loadChannelRoutingPolicies(
  db: SupabaseClient,
  accountId: string
): Promise<ChannelPolicyEntry[]> {
  const { data: policies, error: policiesError } = await db
    .from('channel_routing_policies')
    .select('id, waha_channel_id')
    .eq('account_id', accountId);
  if (policiesError || !policies || policies.length === 0) return [];

  const { data: responsibles, error: responsiblesError } = await db
    .from('channel_routing_responsibles')
    .select('policy_id, user_id')
    .in(
      'policy_id',
      policies.map((p) => p.id)
    );

  const byPolicy = new Map<string, string[]>();
  if (!responsiblesError) {
    for (const row of responsibles ?? []) {
      const bucket = byPolicy.get(row.policy_id) ?? [];
      bucket.push(row.user_id);
      byPolicy.set(row.policy_id, bucket);
    }
  }

  return policies.map((p) => ({
    channelId: p.waha_channel_id ?? null,
    responsibleUserIds: byPolicy.get(p.id) ?? [],
  }));
}

/** Build a lookup map from {@link loadChannelRoutingPolicies}'s result. */
export function policiesToMap(
  entries: ChannelPolicyEntry[]
): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const entry of entries) {
    map.set(policyKey(entry.channelId), entry.responsibleUserIds);
  }
  return map;
}

/**
 * Pure lookup against a map built by {@link policiesToMap} — `null` if
 * this channel has no policy row (unrestricted).
 */
export function eligibleAssigneesFromMap(
  map: Map<string, string[]>,
  whatsappChannelId: string | null
): string[] | null {
  const key = policyKey(whatsappChannelId);
  return map.has(key) ? map.get(key)! : null;
}
