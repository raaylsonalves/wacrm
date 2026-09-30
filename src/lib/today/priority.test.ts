import { describe, it, expect } from 'vitest';
import { priorityReasons, splitByPriority } from './priority';

const now = Date.UTC(2026, 8, 30, 12, 0);
const hoursAgo = (h: number) => new Date(now - h * 3_600_000).toISOString();
const base = {
  assignedAgentId: null,
  handoffWaiting: false,
  hasOpenDeal: false,
};

describe('priorityReasons', () => {
  it('fresh message alone is priority', () => {
    expect(
      priorityReasons({ ...base, lastMessageAt: hoursAgo(2) }, 'me', now)
    ).toEqual(['fresh']);
  });

  it('older than a day with no reason is not', () => {
    expect(
      priorityReasons({ ...base, lastMessageAt: hoursAgo(30) }, 'me', now)
    ).toBeNull();
  });

  it('collects every reason', () => {
    expect(
      priorityReasons(
        {
          lastMessageAt: hoursAgo(30),
          assignedAgentId: 'me',
          handoffWaiting: true,
          hasOpenDeal: true,
        },
        'me',
        now
      )
    ).toEqual(['handoff', 'mine', 'deal']);
  });

  it('past a week nothing is priority', () => {
    expect(
      priorityReasons(
        {
          ...base,
          lastMessageAt: hoursAgo(24 * 8),
          handoffWaiting: true,
          hasOpenDeal: true,
        },
        'me',
        now
      )
    ).toBeNull();
  });

  it("someone else's conversation is not 'mine'", () => {
    expect(
      priorityReasons(
        { ...base, lastMessageAt: hoursAgo(30), assignedAgentId: 'other' },
        'me',
        now
      )
    ).toBeNull();
  });
});

describe('splitByPriority', () => {
  it('orders priority by weight then recency; others by recency', () => {
    const items = [
      { id: 'fresh', lastMessageAt: hoursAgo(1) },
      { id: 'handoff', lastMessageAt: hoursAgo(40), handoffWaiting: true },
      { id: 'deal', lastMessageAt: hoursAgo(30), hasOpenDeal: true },
      { id: 'old', lastMessageAt: hoursAgo(50) },
      { id: 'older', lastMessageAt: hoursAgo(24 * 10) },
    ];
    const r = splitByPriority(items, (i) => ({ ...base, ...i }), 'me', now);
    expect(r.priority.map((p) => p.item.id)).toEqual([
      'handoff',
      'deal',
      'fresh',
    ]);
    expect(r.others.map((o) => o.id)).toEqual(['old', 'older']);
  });
});
