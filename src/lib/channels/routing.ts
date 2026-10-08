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

/** Map key of an official number's own policy (migration 118). */
export function officialPolicyKey(configId: string): string {
  return `cfg:${configId}`;
}

/**
 * The policy row governing a number — the database's own resolver
 * (routing_policy_for, migration 118), so the app and the assignment
 * trigger can never disagree: the WAHA channel's policy, else the
 * official number's (its own, NULL = the primary), else a legacy
 * account-wide Cloud API row. Null = unrestricted.
 */
export async function routingPolicyIdFor(
  db: SupabaseClient,
  accountId: string,
  whatsappChannelId: string | null,
  whatsappConfigId: string | null = null
): Promise<string | null> {
  const { data, error } = await db.rpc('routing_policy_for', {
    p_account: accountId,
    p_channel: whatsappChannelId,
    p_config: whatsappConfigId,
  });
  if (error) return null;
  return (data as string | null) ?? null;
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
  whatsappChannelId: string | null,
  whatsappConfigId: string | null = null
): Promise<string[] | null> {
  const policyId = await routingPolicyIdFor(
    db,
    accountId,
    whatsappChannelId,
    whatsappConfigId
  );
  if (!policyId) return null;
  const policy = { id: policyId };

  const { data: responsibles, error: responsiblesError } = await db
    .from('channel_routing_responsibles')
    .select('user_id')
    .eq('policy_id', policy.id);
  if (responsiblesError) return null;

  return (responsibles ?? []).map((r) => r.user_id as string);
}

export interface ChannelPolicyEntry {
  /** A WAHA channel id, `cfg:<id>` for an official number (migration
   *  118), or `null` for a legacy account-wide Cloud API policy. */
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
    .select('id, waha_channel_id, whatsapp_config_id')
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
    channelId:
      p.waha_channel_id ??
      (p.whatsapp_config_id
        ? officialPolicyKey(p.whatsapp_config_id as string)
        : null),
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
  whatsappChannelId: string | null,
  // Official side: the conversation's number, else the primary; then a
  // legacy account-wide row (same order as routing_policy_for).
  whatsappConfigId: string | null = null,
  primaryConfigId: string | null = null
): string[] | null {
  if (!whatsappChannelId) {
    const numberId = whatsappConfigId ?? primaryConfigId;
    if (numberId) {
      const own = officialPolicyKey(numberId);
      if (map.has(own)) return map.get(own)!;
    }
  }
  const key = policyKey(whatsappChannelId);
  return map.has(key) ? map.get(key)! : null;
}
