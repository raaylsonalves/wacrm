import { describe, it, expect } from 'vitest';
import {
  backoffMs,
  buildEventBody,
  busyBlocksFromEvents,
  connectionFor,
  googleEventId,
  isRetryable,
  signState,
  verifyState,
} from './logic';

describe('googleEventId', () => {
  it('is stable, lowercase hex and valid for Google', () => {
    const id = googleEventId('2893a333-a144-49fc-8b1c-e67d10cb56bb');
    expect(id).toBe(googleEventId('2893a333-a144-49fc-8b1c-e67d10cb56bb'));
    expect(id).toMatch(/^[0-9a-f]{40}$/);
    expect(googleEventId('other')).not.toBe(id);
  });
});

describe('buildEventBody', () => {
  const a = {
    id: 'appt-1',
    title: 'Corte',
    notes: 'Trazer foto',
    starts_at: '2026-10-01T13:00:00.000Z',
    ends_at: '2026-10-01T13:30:00.000Z',
    status: 'scheduled',
    contact: { name: 'Maria', phone: '5585999990000' },
  };

  it('names the customer, tags our id and keeps the timezone', () => {
    const b = buildEventBody(a, {
      timeZone: 'America/Fortaleza',
      includePhone: true,
      appUrl: 'https://crm.x/',
    });
    expect(b.summary).toBe('Corte — Maria');
    expect(b.id).toBe(googleEventId('appt-1'));
    expect(b.extendedProperties).toEqual({
      private: { wacrmAppointmentId: 'appt-1' },
    });
    expect(b.start).toEqual({
      dateTime: a.starts_at,
      timeZone: 'America/Fortaleza',
    });
    expect(b.description).toBe(
      'Trazer foto\nWhatsApp: 5585999990000\nAgenda: https://crm.x/agenda'
    );
  });

  it('leaves the phone out when the owner opted out', () => {
    const b = buildEventBody(a, {
      timeZone: 'UTC',
      includePhone: false,
      appUrl: null,
    });
    expect(b.description).toBe('Trazer foto');
  });
});

describe('busyBlocksFromEvents', () => {
  const tz = 'America/Sao_Paulo';

  it('keeps a normal busy event', () => {
    expect(
      busyBlocksFromEvents(
        [
          {
            id: 'e1',
            start: { dateTime: '2026-10-01T12:00:00-03:00' },
            end: { dateTime: '2026-10-01T13:00:00-03:00' },
          },
        ],
        tz
      )
    ).toEqual([
      {
        google_event_id: 'e1',
        starts_at: '2026-10-01T15:00:00.000Z',
        ends_at: '2026-10-01T16:00:00.000Z',
        all_day: false,
      },
    ]);
  });

  it('blocks all-day events from local midnight to local midnight', () => {
    const [b] = busyBlocksFromEvents(
      [{ id: 'd', start: { date: '2026-10-02' }, end: { date: '2026-10-03' } }],
      tz
    );
    expect(b).toEqual({
      google_event_id: 'd',
      starts_at: '2026-10-02T03:00:00.000Z',
      ends_at: '2026-10-03T03:00:00.000Z',
      all_day: true,
    });
  });

  it('skips our own events, free, cancelled and declined ones', () => {
    const t = {
      start: { dateTime: '2026-10-01T12:00:00Z' },
      end: { dateTime: '2026-10-01T13:00:00Z' },
    };
    expect(
      busyBlocksFromEvents(
        [
          {
            id: 'ours',
            ...t,
            extendedProperties: { private: { wacrmAppointmentId: 'x' } },
          },
          { id: 'free', ...t, transparency: 'transparent' },
          { id: 'gone', ...t, status: 'cancelled' },
          {
            id: 'no',
            ...t,
            attendees: [{ self: true, responseStatus: 'declined' }],
          },
          { id: 'bad', start: { dateTime: 'nope' }, end: { dateTime: 'nope' } },
        ],
        tz
      )
    ).toEqual([]);
  });
});

describe('backoffMs / isRetryable', () => {
  it('honours Retry-After seconds and dates, capped at an hour', () => {
    expect(backoffMs(0, '30')).toBe(30_000);
    expect(backoffMs(0, '99999')).toBe(3_600_000);
    const now = Date.parse('2026-10-01T00:00:00Z');
    expect(backoffMs(0, 'Thu, 01 Oct 2026 00:02:00 GMT', now)).toBe(120_000);
  });

  it('grows exponentially without a header', () => {
    expect(backoffMs(0, null)).toBe(60_000);
    expect(backoffMs(3, null)).toBe(480_000);
    expect(backoffMs(20, null)).toBe(3_600_000);
  });

  it('retries 429 and 5xx only', () => {
    expect(isRetryable(429)).toBe(true);
    expect(isRetryable(503)).toBe(true);
    expect(isRetryable(400)).toBe(false);
    expect(isRetryable(404)).toBe(false);
  });
});

describe('connectionFor', () => {
  const conns = [
    { id: 'shared', user_id: null, status: 'active' },
    { id: 'ana', user_id: 'u-ana', status: 'active' },
    { id: 'bob', user_id: 'u-bob', status: 'needs_reauth' },
  ];
  it('prefers the assignee, falls back to shared, skips inactive', () => {
    expect(connectionFor(conns, 'u-ana')?.id).toBe('ana');
    expect(connectionFor(conns, 'u-bob')?.id).toBe('shared');
    expect(connectionFor(conns, null)?.id).toBe('shared');
    expect(connectionFor([conns[2]], 'u-bob')).toBeNull();
  });
});

describe('OAuth state', () => {
  const s = {
    accountId: 'a',
    userId: 'u',
    nonce: 'n',
    exp: Date.now() + 60_000,
  };

  it('round-trips', () => {
    expect(verifyState(signState(s, 'k'), 'k')).toEqual(s);
  });

  it('rejects tampering, a wrong key and expiry', () => {
    const tok = signState(s, 'k');
    const [body, mac] = tok.split('.');
    const forged = Buffer.from(
      JSON.stringify({ ...s, accountId: 'other' })
    ).toString('base64url');
    expect(verifyState(`${forged}.${mac}`, 'k')).toBeNull();
    expect(verifyState(`${body}.${mac}`, 'other-key')).toBeNull();
    expect(verifyState(signState({ ...s, exp: 1 }, 'k'), 'k')).toBeNull();
    expect(verifyState('garbage', 'k')).toBeNull();
  });
});
