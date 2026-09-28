// ============================================================
// Channel rotation for a WAHA broadcast (specs/broadcast-channel-
// rotation.md). "The one with the most headroom sends next" maps
// onto `whatsapp_waha_channels.last_sent_at` — the exact bookkeeping
// column the send throttle (migration 064, `claim_waha_send_slot`)
// already maintains. Picking the pool member with the OLDEST
// `last_sent_at` (nulls — never sent — first) is "most headroom";
// no new column needed, this reads a signal that already exists.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

export interface RotationChannel {
  id: string;
  waha_base_url: string;
  waha_api_key: string;
  waha_session_name: string;
  connected_at: string | null;
}

/**
 * The next channel a WAHA broadcast should send from: the primary
 * plus its rotation pool, restricted to `status = 'connected'` (a
 * disconnected/connecting channel would otherwise still look "most
 * idle" and get picked repeatedly — see the spec's own risk note on
 * `last_sent_at` alone not distinguishing idle from broken), ordered
 * by `last_sent_at` ascending with nulls first.
 *
 * Returns `null` when no channel in the primary+pool set is currently
 * connected — the caller fails that recipient with a clear reason
 * rather than sending from a channel that can't actually deliver.
 */
export async function pickNextChannel(
  db: SupabaseClient,
  primaryChannelId: string,
  poolChannelIds: string[]
): Promise<RotationChannel | null> {
  const candidateIds = Array.from(
    new Set([primaryChannelId, ...poolChannelIds])
  );

  const { data, error } = await db
    .from('whatsapp_waha_channels')
    .select(
      'id, waha_base_url, waha_api_key, waha_session_name, connected_at, last_sent_at'
    )
    .in('id', candidateIds)
    .eq('status', 'connected')
    .order('last_sent_at', { ascending: true, nullsFirst: true })
    .limit(1);

  if (error || !data || data.length === 0) return null;
  return data[0];
}
