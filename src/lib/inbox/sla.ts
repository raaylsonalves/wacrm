import type { Conversation } from '@/types';

export type SlaTier = 'ok' | 'warning' | 'breached';

export interface SlaStatus {
  tier: SlaTier;
  elapsedMinutes: number;
}

/**
 * specs/inbox-response-time-sla.md — live per-conversation SLA status
 * for the inbox conversation list. Pure so it's unit-testable without
 * mocking React/Supabase, per this repo's convention (see CLAUDE.md's
 * "Pure helpers" note) — `conversation-list.tsx` is the only caller.
 *
 * Only meaningful while the customer is the one waiting: a
 * conversation whose last message is from an agent/bot has already
 * been answered, and a closed conversation isn't being worked. `null`
 * means "don't show a badge," not "everything's fine" — those are
 * different states in the UI.
 */
export function slaTier(
  conversation: Pick<
    Conversation,
    'status' | 'last_message_sender_type' | 'last_message_at'
  >,
  now: number,
  targetMinutes: number
): SlaStatus | null {
  if (conversation.status === 'closed') return null;
  if (conversation.last_message_sender_type !== 'customer') return null;
  if (!conversation.last_message_at) return null;

  const elapsedMinutes =
    (now - new Date(conversation.last_message_at).getTime()) / 60_000;
  if (elapsedMinutes < 0) return null; // clock skew guard

  const tier: SlaTier =
    elapsedMinutes >= targetMinutes * 2
      ? 'breached'
      : elapsedMinutes >= targetMinutes
        ? 'warning'
        : 'ok';
  return { tier, elapsedMinutes };
}

/** "5m" / "1h 20m" — deliberately not `formatDistanceToNow`'s prose
 *  ("5 minutes") so the badge stays compact next to the status dot. */
export function formatElapsedMinutes(minutes: number): string {
  const totalMinutes = Math.floor(minutes);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
