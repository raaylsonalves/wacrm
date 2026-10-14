// Which external scheduling provider, if any, an account's AI books into
// (migration 130). Service-role reads only: the key column is never
// selectable by a browser.

import type { SupabaseClient } from '@supabase/supabase-js';
import { decrypt } from '@/lib/whatsapp/encryption';
import { createScaleClient, type ScaleClient } from './scale';

export interface SchedulingIntegration {
  provider: 'scale';
  client: ScaleClient;
}

export async function loadSchedulingIntegration(
  db: SupabaseClient,
  accountId: string
): Promise<SchedulingIntegration | null> {
  const { data, error } = await db
    .from('scheduling_integrations')
    .select('provider, api_key_enc, base_url, enabled')
    .eq('account_id', accountId)
    .maybeSingle();
  if (error || !data || !data.enabled || data.provider !== 'scale') return null;
  try {
    return {
      provider: 'scale',
      client: createScaleClient(
        decrypt(data.api_key_enc as string),
        data.base_url as string
      ),
    };
  } catch (err) {
    console.error('[scheduling] could not decrypt the partner key:', err);
    return null;
  }
}

/** Remember the last failure on the settings card; cleared on success. */
export async function recordSchedulingError(
  db: SupabaseClient,
  accountId: string,
  message: string | null
): Promise<void> {
  await db
    .from('scheduling_integrations')
    .update({ last_error: message, updated_at: new Date().toISOString() })
    .eq('account_id', accountId);
}
