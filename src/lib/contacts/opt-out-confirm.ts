import type { SupabaseClient } from '@supabase/supabase-js';
import { engineSendText } from '@/lib/flows/meta-send';
import {
  handoffNoticeText,
  loadHandoffNoticeDict,
} from '@/lib/ai/handoff-notice';

export type OptOutConfirmResult = 'sent' | 'already' | 'failed' | 'no_text';

const RETRY_DELAY_MS = 1500;

/**
 * Tell a customer who wrote STOP that they won't get more messages — once
 * per opt-out, whatever state the AI is in (off, paused on this thread,
 * or a flow owns it). Before migration 101 this only rode the AI's
 * handoff notice, so a paused AI meant no confirmation at all.
 *
 * `contacts.opt_out_confirmed_at` is the claim: the first caller (a
 * webhook, or the AI handoff) sets it and sends; the others see it set
 * and stand down, so the customer never gets two confirmations. A send
 * that fails after one retry releases the claim.
 *
 * Never throws.
 */
export async function confirmOptOut(
  db: SupabaseClient,
  args: {
    accountId: string;
    contactId: string;
    conversationId: string;
    userId: string;
  }
): Promise<OptOutConfirmResult> {
  try {
    const { data: claimed } = await db
      .from('contacts')
      .update({ opt_out_confirmed_at: new Date().toISOString() })
      .eq('id', args.contactId)
      .eq('account_id', args.accountId)
      .not('opted_out_at', 'is', null)
      .is('opt_out_confirmed_at', null)
      .select('id');
    if (!claimed || claimed.length === 0) return 'already';

    const text = handoffNoticeText({
      optOut: true,
      teamOnline: false,
      leadKey: args.conversationId,
      dict: await loadHandoffNoticeDict(),
    });
    if (!text) return 'no_text';

    const send = () =>
      engineSendText({
        accountId: args.accountId,
        userId: args.userId,
        conversationId: args.conversationId,
        contactId: args.contactId,
        text,
        aiGenerated: false,
      });
    try {
      await send();
    } catch (first) {
      console.warn(
        '[opt-out] confirmation failed, retrying once:',
        first instanceof Error ? first.message : first
      );
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      try {
        await send();
      } catch (second) {
        console.warn(
          '[opt-out] confirmation failed:',
          second instanceof Error ? second.message : second
        );
        await db
          .from('contacts')
          .update({ opt_out_confirmed_at: null })
          .eq('id', args.contactId);
        return 'failed';
      }
    }
    return 'sent';
  } catch (err) {
    console.warn(
      '[opt-out] confirmation errored:',
      err instanceof Error ? err.message : err
    );
    return 'failed';
  }
}
