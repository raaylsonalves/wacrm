import { describe, expect, it } from 'vitest';
import {
  arrivalsByHour,
  byDay,
  formatDuration,
  median,
  perResponder,
  summarize,
  type LeadRow,
  type ResponseRow,
} from './service';

const lead = (over: Partial<LeadRow>): LeadRow => ({
  conversation_id: 'c',
  contact_id: 'ct',
  contact_name: 'Ana',
  contact_phone: '5511',
  whatsapp_config_id: null,
  whatsapp_channel_id: null,
  arrived_at: '2026-10-01T12:00:00Z',
  first_reply_at: null,
  first_reply_kind: null,
  first_reply_user_id: null,
  assigned_agent_id: null,
  status: 'open',
  ...over,
});

const resp = (over: Partial<ResponseRow>): ResponseRow => ({
  conversation_id: 'c',
  customer_at: '2026-10-01T12:00:00Z',
  replied_at: '2026-10-01T12:02:00Z',
  reply_kind: 'human',
  reply_user_id: 'u1',
  ...over,
});

describe('summarize', () => {
  it('counts answered / unanswered and the target', () => {
    const s = summarize(
      [
        lead({ first_reply_at: '2026-10-01T12:01:00Z', first_reply_kind: 'ai' }),
        lead({ first_reply_at: '2026-10-01T12:30:00Z', first_reply_kind: 'human' }),
        lead({}),
      ],
      5
    );
    expect(s).toMatchObject({ leads: 3, answered: 2, unanswered: 1, withinTargetPct: 50, aiFirstPct: 50 });
    expect(s.medianFirstMinutes).toBe(15.5);
  });

  it('has no percentages without answers', () => {
    expect(summarize([lead({})], 5)).toMatchObject({ withinTargetPct: null, medianFirstMinutes: null });
  });
});

describe('perResponder', () => {
  it('groups people apart, the AI as one row, ignores automations', () => {
    const rows = perResponder(
      [
        resp({ reply_user_id: 'u1', replied_at: '2026-10-01T12:10:00Z' }),
        resp({ reply_user_id: 'u2', replied_at: '2026-10-01T12:01:00Z' }),
        resp({ reply_kind: 'ai', reply_user_id: null, replied_at: '2026-10-01T12:00:30Z' }),
        resp({ reply_kind: 'automation', reply_user_id: null }),
      ],
      5
    );
    expect(rows.map((r) => r.key)).toEqual(['ai', 'u2', 'u1']);
    expect(rows.find((r) => r.key === 'u1')?.withinTargetPct).toBe(0);
  });
});

describe('helpers', () => {
  it('median', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([])).toBeNull();
  });
  it('formatDuration', () => {
    expect(formatDuration(0.5)).toBe('30 s');
    expect(formatDuration(12.4)).toBe('12 min');
    expect(formatDuration(190)).toBe('3 h 10 min');
    expect(formatDuration(60 * 50)).toBe('2 d 2 h');
    expect(formatDuration(null)).toBe('—');
  });
  it('arrivalsByHour has 24 buckets', () => {
    expect(arrivalsByHour([lead({})]).reduce((a, b) => a + b, 0)).toBe(1);
  });
  it('byDay includes empty days', () => {
    const points = byDay([], [], new Date('2026-10-01T12:00:00'), new Date('2026-10-04T12:00:00'));
    expect(points).toHaveLength(3);
    expect(points.every((p) => p.leads === 0 && p.ai === null)).toBe(true);
  });
});
