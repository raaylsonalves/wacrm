// Detects an automated sender on the other side — a company's own bot
// (seen live: a carrier's self-service menu) answering our AI, which
// answered back, for twenty minutes. Nobody types 60+ characters in a few
// seconds, and nobody repeats the same long message again and again.
// Pure, so it is unit-tested; auto-reply.ts acts on it.

export interface RecentMessage {
  sender_type: string;
  created_at: string;
  content_text: string | null;
}

/** A reply this fast, this long, was not typed by a person. */
const MACHINE_REPLY_MS = 8_000;
const MACHINE_REPLY_MIN_CHARS = 60;
/** How many machine-speed replies, or repeats, make it a bot. */
const THRESHOLD = 2;

const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * `recent` is the conversation's latest messages, any order. True when
 * the customer side behaves like a bot: at least two long messages sent
 * within seconds of ours, or the same long message repeated.
 */
export function looksLikeAutomatedSender(recent: RecentMessage[]): boolean {
  const msgs = [...recent].sort((a, b) => a.created_at.localeCompare(b.created_at));
  let machineReplies = 0;
  const seen = new Map<string, number>();
  let repeats = 0;
  let lastOursAt: number | null = null;

  for (const m of msgs) {
    const at = new Date(m.created_at).getTime();
    if (m.sender_type !== 'customer') {
      lastOursAt = at;
      continue;
    }
    const text = m.content_text ?? '';
    if (text.length >= MACHINE_REPLY_MIN_CHARS) {
      if (lastOursAt !== null && at - lastOursAt >= 0 && at - lastOursAt <= MACHINE_REPLY_MS) {
        machineReplies++;
      }
      const key = normalize(text);
      const n = (seen.get(key) ?? 0) + 1;
      seen.set(key, n);
      if (n >= 2) repeats++;
    }
  }
  return machineReplies >= THRESHOLD || repeats >= THRESHOLD;
}

/** The placeholder the webhook stores for a message type it can't read. */
export function isUnsupportedPlaceholder(text: string): boolean {
  return /^\[Unsupported message type: [^\]]*\]$/.test(text.trim());
}
