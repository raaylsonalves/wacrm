/**
 * WhatsApp groups consecutive messages from the same side into one "run":
 * only the first bubble of a run carries the tail, and bubbles inside a run
 * sit close together. A long pause starts a new run even on the same side.
 */
export const RUN_GAP_MS = 10 * 60 * 1000;

interface RunMessage {
  sender_type: string;
  created_at: string;
}

const side = (m: RunMessage) => (m.sender_type === 'customer' ? 'in' : 'out');

/** True when `msg` opens a new run after `prev` (or there is no prev). */
export function startsRun(
  prev: RunMessage | null | undefined,
  msg: RunMessage
): boolean {
  if (!prev) return true;
  if (side(prev) !== side(msg)) return true;
  const gap =
    new Date(msg.created_at).getTime() - new Date(prev.created_at).getTime();
  return !(gap >= 0 && gap <= RUN_GAP_MS);
}

/** Customer messages after the first `seen` — the count on the
 *  "jump to latest" button while the agent is scrolled up. */
export function unseenCount(messages: RunMessage[], seen: number): number {
  let n = 0;
  for (let i = Math.max(0, seen); i < messages.length; i++) {
    if (messages[i].sender_type === 'customer') n++;
  }
  return n;
}
