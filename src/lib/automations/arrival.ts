// customer_arrived (automations): how long the customer had been quiet
// before the message just stored. Across all of the contact's
// conversations, like first_inbound_message.

import type { SupabaseClient } from '@supabase/supabase-js';

/** Hours between the customer's two latest messages; null = their first. */
export async function hoursSincePreviousCustomerMessage(
  db: SupabaseClient,
  accountId: string,
  contactId: string
): Promise<number | null> {
  // Best-effort: a failed lookup must not stop the webhook fan-out.
  try {
    const { data: convs } = await db
      .from('conversations')
      .select('id')
      .eq('account_id', accountId)
      .eq('contact_id', contactId);
    const ids = (convs ?? []).map((c: { id: string }) => c.id);
    if (ids.length === 0) return null;
    const { data: rows } = await db
      .from('messages')
      .select('created_at')
      .in('conversation_id', ids)
      .eq('sender_type', 'customer')
      .order('created_at', { ascending: false })
      .limit(2);
    return idleHours(
      (rows ?? []).map((r: { created_at: string }) => r.created_at)
    );
  } catch (err) {
    console.error('[automations] idle-hours lookup failed:', err);
    return null;
  }
}

/** Pure part: newest-first timestamps of the customer's messages. */
export function idleHours(newestFirst: string[]): number | null {
  if (newestFirst.length < 2) return null;
  const gap =
    new Date(newestFirst[0]).getTime() - new Date(newestFirst[1]).getTime();
  return Math.max(0, gap) / 3_600_000;
}
