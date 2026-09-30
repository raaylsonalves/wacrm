import { describe, it, expect } from 'vitest';
import { AI_STUCK_MS, earliestByContact, workQueueOf } from './work-queue';

const now = Date.UTC(2026, 8, 30, 12, 0);
const ago = (ms: number) => new Date(now - ms).toISOString();
const base = { command: 'human' as const, snoozed: false, now };

describe('workQueueOf', () => {
  it('customer spoke last → reply', () => {
    expect(
      workQueueOf({
        ...base,
        lastSenderType: 'customer',
        lastMessageAt: ago(60_000),
      })
    ).toBe('reply');
  });

  it('we spoke last → waiting', () => {
    expect(workQueueOf({ ...base, lastSenderType: 'agent' })).toBe('waiting');
    expect(workQueueOf({ ...base, lastSenderType: 'bot' })).toBe('waiting');
  });

  it('an AI thread is not the person’s queue until the AI is stuck', () => {
    const ai = { ...base, command: 'ai' as const, lastSenderType: 'customer' };
    expect(workQueueOf({ ...ai, lastMessageAt: ago(60_000) })).toBeNull();
    expect(workQueueOf({ ...ai, lastMessageAt: ago(AI_STUCK_MS + 1000) })).toBe(
      'reply'
    );
  });

  it('appointment → scheduled, but a customer message still wins', () => {
    const appt = { ...base, nextAppointmentAt: ago(-3_600_000) };
    expect(workQueueOf({ ...appt, lastSenderType: 'agent' })).toBe('scheduled');
    expect(
      workQueueOf({
        ...appt,
        lastSenderType: 'customer',
        lastMessageAt: ago(0),
      })
    ).toBe('reply');
  });

  it('closed, snoozed or empty → no queue', () => {
    expect(
      workQueueOf({ ...base, command: 'closed', lastSenderType: 'customer' })
    ).toBeNull();
    expect(
      workQueueOf({ ...base, snoozed: true, lastSenderType: 'customer' })
    ).toBeNull();
    expect(workQueueOf({ ...base })).toBeNull();
  });
});

describe('earliestByContact', () => {
  it('keeps the earliest per contact', () => {
    const m = earliestByContact([
      { contact_id: 'a', starts_at: '2026-10-02T10:00:00Z', title: 'late' },
      { contact_id: 'a', starts_at: '2026-10-01T10:00:00Z', title: 'early' },
      { contact_id: 'b', starts_at: '2026-10-03T10:00:00Z', title: 'b' },
    ]);
    expect(m.get('a')?.title).toBe('early');
    expect(m.size).toBe(2);
  });
});
