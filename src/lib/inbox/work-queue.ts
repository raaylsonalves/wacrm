import type { Command } from './signals';

/**
 * The inbox as a to-do list: which queue a conversation sits in, from the
 * agent's point of view.
 *
 *  - reply     — the customer spoke last and a person owes the answer.
 *                A thread the AI answers doesn't count, unless the AI has
 *                sat on the message long enough that something is wrong.
 *  - scheduled — there is an upcoming appointment with this contact.
 *  - waiting   — we spoke last; the ball is in the customer's court.
 *
 * reply wins over scheduled: a customer who wrote needs an answer even if
 * a meeting is booked for next week.
 */
export type WorkQueue = 'reply' | 'waiting' | 'scheduled';

/** How long the AI may sit on a customer message before a person should look. */
export const AI_STUCK_MS = 5 * 60 * 1000;

export function workQueueOf(args: {
  command: Command;
  snoozed: boolean;
  lastSenderType?: string | null;
  lastMessageAt?: string | null;
  /** Earliest upcoming appointment with this contact, if any. */
  nextAppointmentAt?: string | null;
  now: number;
}): WorkQueue | null {
  if (args.command === 'closed' || args.snoozed) return null;
  if (args.lastSenderType === 'customer') {
    if (args.command !== 'ai') return 'reply';
    const at = args.lastMessageAt
      ? new Date(args.lastMessageAt).getTime()
      : NaN;
    if (Number.isFinite(at) && args.now - at > AI_STUCK_MS) return 'reply';
    // The AI is on it — not the person's queue yet.
    return args.nextAppointmentAt ? 'scheduled' : null;
  }
  if (args.nextAppointmentAt) return 'scheduled';
  if (args.lastSenderType) return 'waiting';
  return null;
}

export interface UpcomingAppointment {
  contact_id: string;
  starts_at: string;
  title: string;
}

/** contact_id → its earliest upcoming appointment. */
export function earliestByContact(
  rows: UpcomingAppointment[]
): Map<string, UpcomingAppointment> {
  const map = new Map<string, UpcomingAppointment>();
  for (const r of rows) {
    const cur = map.get(r.contact_id);
    if (!cur || r.starts_at < cur.starts_at) map.set(r.contact_id, r);
  }
  return map;
}
