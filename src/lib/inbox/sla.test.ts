import { describe, it, expect } from 'vitest';
import { slaTier, formatElapsedMinutes } from './sla';
import type { Conversation } from '@/types';

type Conv = Pick<
  Conversation,
  'status' | 'last_message_sender_type' | 'last_message_at'
>;

const NOW = new Date('2026-01-01T12:00:00Z').getTime();

function conv(overrides: Partial<Conv> = {}): Conv {
  return {
    status: 'open',
    last_message_sender_type: 'customer',
    last_message_at: new Date(NOW - 3 * 60_000).toISOString(),
    ...overrides,
  };
}

describe('slaTier', () => {
  it('returns null for a closed conversation regardless of wait time', () => {
    expect(
      slaTier(
        conv({
          status: 'closed',
          last_message_at: new Date(NOW - 999 * 60_000).toISOString(),
        }),
        NOW,
        5
      )
    ).toBeNull();
  });

  it('returns null once the last message is from an agent (already replied)', () => {
    expect(
      slaTier(conv({ last_message_sender_type: 'agent' }), NOW, 5)
    ).toBeNull();
  });

  it('returns null once the last message is from the bot (already replied)', () => {
    expect(
      slaTier(conv({ last_message_sender_type: 'bot' }), NOW, 5)
    ).toBeNull();
  });

  it('returns null when there is no last message yet', () => {
    expect(slaTier(conv({ last_message_at: undefined }), NOW, 5)).toBeNull();
  });

  it('returns null on clock skew (a last_message_at in the future)', () => {
    expect(
      slaTier(
        conv({ last_message_at: new Date(NOW + 60_000).toISOString() }),
        NOW,
        5
      )
    ).toBeNull();
  });

  it("is 'ok' under the target", () => {
    const result = slaTier(
      conv({ last_message_at: new Date(NOW - 2 * 60_000).toISOString() }),
      NOW,
      5
    );
    expect(result?.tier).toBe('ok');
    expect(result?.elapsedMinutes).toBeCloseTo(2, 5);
  });

  it("is 'warning' at or past the target but under double", () => {
    const result = slaTier(
      conv({ last_message_at: new Date(NOW - 7 * 60_000).toISOString() }),
      NOW,
      5
    );
    expect(result?.tier).toBe('warning');
  });

  it("is exactly 'warning' right at the target boundary", () => {
    const result = slaTier(
      conv({ last_message_at: new Date(NOW - 5 * 60_000).toISOString() }),
      NOW,
      5
    );
    expect(result?.tier).toBe('warning');
  });

  it("is 'breached' at or past double the target", () => {
    const result = slaTier(
      conv({ last_message_at: new Date(NOW - 10 * 60_000).toISOString() }),
      NOW,
      5
    );
    expect(result?.tier).toBe('breached');
  });
});

describe('formatElapsedMinutes', () => {
  it('formats under an hour as plain minutes', () => {
    expect(formatElapsedMinutes(7)).toBe('7m');
  });

  it('formats an hour or more as hours + minutes', () => {
    expect(formatElapsedMinutes(80)).toBe('1h 20m');
  });

  it('floors fractional minutes', () => {
    expect(formatElapsedMinutes(7.9)).toBe('7m');
  });
});
