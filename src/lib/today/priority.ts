/**
 * Splits the Reply queue into "priority" and "other unanswered" for the
 * dashboard. A conversation is priority when it is recent enough to still
 * be live (≤ 7 days) and has at least one reason a person should answer it
 * first. The reasons are shown on the card, so the rule is never a mystery.
 */

export type PriorityReason = 'handoff' | 'mine' | 'deal' | 'fresh';

export const FRESH_MS = 24 * 60 * 60 * 1000;
export const STALE_MS = 7 * 24 * 60 * 60 * 1000;

// Weight decides the order among priority conversations.
const WEIGHT: Record<PriorityReason, number> = {
  handoff: 8,
  mine: 4,
  deal: 2,
  fresh: 1,
};

export interface PriorityInput {
  lastMessageAt: string | null | undefined;
  assignedAgentId: string | null | undefined;
  /** The AI stopped (hand-off / pause) and nobody took it. */
  handoffWaiting: boolean;
  hasOpenDeal: boolean;
}

export function priorityReasons(
  c: PriorityInput,
  me: string | null | undefined,
  now: number
): PriorityReason[] | null {
  const at = c.lastMessageAt ? new Date(c.lastMessageAt).getTime() : NaN;
  if (!Number.isFinite(at) || now - at > STALE_MS) return null;
  const reasons: PriorityReason[] = [];
  if (c.handoffWaiting) reasons.push('handoff');
  if (me && c.assignedAgentId === me) reasons.push('mine');
  if (c.hasOpenDeal) reasons.push('deal');
  if (now - at <= FRESH_MS) reasons.push('fresh');
  return reasons.length > 0 ? reasons : null;
}

export function priorityScore(reasons: PriorityReason[]): number {
  return reasons.reduce((s, r) => s + WEIGHT[r], 0);
}

/**
 * Priority first by score, then most recent; the rest most recent first.
 */
export function splitByPriority<T>(
  items: T[],
  input: (item: T) => PriorityInput,
  me: string | null | undefined,
  now: number
): { priority: { item: T; reasons: PriorityReason[] }[]; others: T[] } {
  const priority: {
    item: T;
    reasons: PriorityReason[];
    score: number;
    at: string;
  }[] = [];
  const others: { item: T; at: string }[] = [];
  for (const item of items) {
    const i = input(item);
    const reasons = priorityReasons(i, me, now);
    const at = i.lastMessageAt ?? '';
    if (reasons)
      priority.push({ item, reasons, score: priorityScore(reasons), at });
    else others.push({ item, at });
  }
  priority.sort((a, b) => b.score - a.score || b.at.localeCompare(a.at));
  others.sort((a, b) => b.at.localeCompare(a.at));
  return {
    priority: priority.map(({ item, reasons }) => ({ item, reasons })),
    others: others.map((o) => o.item),
  };
}
