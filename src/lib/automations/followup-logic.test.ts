import { describe, it, expect } from 'vitest'
import {
  FOLLOWUP_WEEKLY_CAP,
  decideFollowupStep,
  isInSendWindow,
  nextSendTime,
  parseSilenceConfig,
  sweepBounds,
  zonedParts,
  type GuardSnapshot,
  type SendWindow,
} from './followup-logic'

const NOW = new Date('2026-09-29T15:00:00Z') // Tue 12:00 in São Paulo (UTC-3)
const EPISODE = new Date('2026-09-29T09:00:00Z')

function snap(over: Partial<GuardSnapshot> = {}): GuardSnapshot {
  return {
    now: NOW,
    enrollmentActive: true,
    episodeAt: EPISODE,
    lastCustomerMessageAt: EPISODE,
    contactOptedOut: false,
    conversationStatus: 'open',
    snoozedUntil: null,
    humanOwnsAndPolicyCancels: false,
    isCloudApi: false,
    stepIsTemplate: false,
    sendsInCapWindow: 0,
    weeklyCap: FOLLOWUP_WEEKLY_CAP,
    window: undefined,
    ...over,
  }
}

describe('parseSilenceConfig', () => {
  const ok = { silence_after: { amount: 4, unit: 'hours' } }

  it('applies the documented defaults', () => {
    expect(parseSilenceConfig(ok)).toEqual({
      silence_after: { amount: 4, unit: 'hours' },
      audience: 'ai_conversations',
      max_age_days: 14,
      send_window: undefined,
      handoff_policy: 'cancel',
    })
  })

  it('rejects what cannot describe a sweep', () => {
    expect(parseSilenceConfig(null)).toBeNull()
    expect(parseSilenceConfig({})).toBeNull()
    expect(parseSilenceConfig({ silence_after: { amount: 'x', unit: 'hours' } })).toBeNull()
    expect(parseSilenceConfig({ silence_after: { amount: 2, unit: 'weeks' } })).toBeNull()
  })

  it('enforces the 5-minute floor', () => {
    expect(parseSilenceConfig({ silence_after: { amount: 4, unit: 'minutes' } })).toBeNull()
    expect(parseSilenceConfig({ silence_after: { amount: 5, unit: 'minutes' } })).not.toBeNull()
  })

  it('reads audience, policy and window, dropping invalid windows', () => {
    const cfg = parseSilenceConfig({
      ...ok,
      audience: 'all_open',
      handoff_policy: 'allow',
      max_age_days: 3,
      send_window: { start_hour: 9, end_hour: 18, tz: 'America/Sao_Paulo', days: [1, 2, 9] },
    })
    expect(cfg).toMatchObject({
      audience: 'all_open',
      handoff_policy: 'allow',
      max_age_days: 3,
      send_window: { start_hour: 9, end_hour: 18, tz: 'America/Sao_Paulo', days: [1, 2] },
    })
    expect(parseSilenceConfig({ ...ok, send_window: { start_hour: 9, end_hour: 9, tz: 'UTC' } })
      ?.send_window).toBeUndefined()
  })

  it('falls back to UTC for an unknown time zone', () => {
    expect(
      parseSilenceConfig({ ...ok, send_window: { start_hour: 9, end_hour: 18, tz: 'Mars/Base' } })
        ?.send_window?.tz,
    ).toBe('UTC')
  })
})

describe('sweepBounds', () => {
  it('spans "silent for at least X" back to max_age_days', () => {
    const cfg = parseSilenceConfig({ silence_after: { amount: 4, unit: 'hours' }, max_age_days: 2 })!
    const { silentBefore, notOlderThan } = sweepBounds(cfg, NOW)
    expect(silentBefore.toISOString()).toBe('2026-09-29T11:00:00.000Z')
    expect(notOlderThan.toISOString()).toBe('2026-09-27T15:00:00.000Z')
  })
})

describe('send window', () => {
  const sp: SendWindow = { start_hour: 9, end_hour: 18, tz: 'America/Sao_Paulo' }

  it('reads hour and weekday in the zone, not in UTC', () => {
    expect(zonedParts(NOW, 'America/Sao_Paulo')).toEqual({ hour: 12, weekday: 2 })
    expect(zonedParts(new Date('2026-09-29T02:00:00Z'), 'America/Sao_Paulo')).toEqual({
      hour: 23,
      weekday: 1,
    })
  })

  it('is open inside and closed outside, end exclusive', () => {
    expect(isInSendWindow(NOW, sp)).toBe(true)
    expect(isInSendWindow(new Date('2026-09-29T21:00:00Z'), sp)).toBe(false) // 18:00
    expect(isInSendWindow(new Date('2026-09-29T11:59:00Z'), sp)).toBe(false) // 08:59
    expect(isInSendWindow(NOW, undefined)).toBe(true)
  })

  it('honours allowed weekdays', () => {
    const weekdays: SendWindow = { ...sp, days: [1, 2, 3, 4, 5] }
    expect(isInSendWindow(NOW, weekdays)).toBe(true) // Tuesday
    expect(isInSendWindow(new Date('2026-10-03T15:00:00Z'), weekdays)).toBe(false) // Saturday
  })

  it('supports a window that wraps midnight', () => {
    const night: SendWindow = { start_hour: 22, end_hour: 6, tz: 'UTC' }
    expect(isInSendWindow(new Date('2026-09-29T23:00:00Z'), night)).toBe(true)
    expect(isInSendWindow(new Date('2026-09-29T03:00:00Z'), night)).toBe(true)
    expect(isInSendWindow(new Date('2026-09-29T12:00:00Z'), night)).toBe(false)
  })

  it('defers a step that comes due at 3am to the next opening', () => {
    const at3am = new Date('2026-09-29T06:00:00Z') // 03:00 São Paulo
    expect(nextSendTime(at3am, sp).toISOString()).toBe('2026-09-29T12:00:00.000Z') // 09:00
  })

  it('skips to Monday when the window excludes the weekend', () => {
    const weekdays: SendWindow = { ...sp, days: [1, 2, 3, 4, 5] }
    const saturdayNoon = new Date('2026-10-03T15:00:00Z')
    expect(nextSendTime(saturdayNoon, weekdays).toISOString()).toBe('2026-10-05T12:00:00.000Z')
  })

  it('returns the instant itself when already inside', () => {
    expect(nextSendTime(NOW, sp)).toBe(NOW)
  })

  it('falls back instead of looping forever for a window that never opens', () => {
    const never: SendWindow = { ...sp, days: [] } // normalised away by the parser, but be safe
    const t = nextSendTime(NOW, { ...never, days: [7 as number] })
    expect(t.getTime()).toBeGreaterThan(NOW.getTime())
  })
})

describe('decideFollowupStep — the truth table', () => {
  it('sends when nothing is wrong', () => {
    expect(decideFollowupStep(snap())).toEqual({ kind: 'send' })
  })

  it('stops silently when the enrollment already ended', () => {
    expect(decideFollowupStep(snap({ enrollmentActive: false }))).toEqual({
      kind: 'stop',
      outcome: null,
    })
  })

  it('stops as replied when the customer has spoken since the episode began', () => {
    expect(
      decideFollowupStep(
        snap({ lastCustomerMessageAt: new Date('2026-09-29T14:59:00Z') }),
      ),
    ).toEqual({ kind: 'stop', outcome: 'replied' })
  })

  it('stops for opt-out, closed thread and a person taking over', () => {
    expect(decideFollowupStep(snap({ contactOptedOut: true }))).toEqual({
      kind: 'stop',
      outcome: 'opted_out',
    })
    expect(decideFollowupStep(snap({ conversationStatus: 'closed' }))).toEqual({
      kind: 'stop',
      outcome: 'closed',
    })
    expect(decideFollowupStep(snap({ humanOwnsAndPolicyCancels: true }))).toEqual({
      kind: 'stop',
      outcome: 'handoff',
    })
  })

  it('prefers "replied" over the softer reasons', () => {
    expect(
      decideFollowupStep(
        snap({
          lastCustomerMessageAt: new Date('2026-09-29T14:00:00Z'),
          contactOptedOut: true,
          conversationStatus: 'closed',
        }),
      ),
    ).toEqual({ kind: 'stop', outcome: 'replied' })
  })

  describe('the 24h session window (Cloud API only)', () => {
    const late = { now: new Date('2026-09-30T10:00:00Z') } // 25h after EPISODE

    it('ends the sequence for a free-form step past 24h', () => {
      expect(decideFollowupStep(snap({ ...late, isCloudApi: true }))).toEqual({
        kind: 'stop',
        outcome: 'window_closed',
      })
    })

    it('still lets an approved template go out', () => {
      expect(
        decideFollowupStep(snap({ ...late, isCloudApi: true, stepIsTemplate: true })),
      ).toEqual({ kind: 'send' })
    })

    it('does not apply on WAHA channels', () => {
      expect(decideFollowupStep(snap({ ...late, isCloudApi: false }))).toEqual({
        kind: 'send',
      })
    })

    it('is open at exactly 24h', () => {
      expect(
        decideFollowupStep(
          snap({ isCloudApi: true, now: new Date(EPISODE.getTime() + 24 * 3_600_000) }),
        ),
      ).toEqual({ kind: 'send' })
    })
  })

  describe('the per-contact frequency cap', () => {
    it('allows up to the cap and stops at it', () => {
      expect(decideFollowupStep(snap({ sendsInCapWindow: FOLLOWUP_WEEKLY_CAP - 1 }))).toEqual({
        kind: 'send',
      })
      expect(decideFollowupStep(snap({ sendsInCapWindow: FOLLOWUP_WEEKLY_CAP }))).toEqual({
        kind: 'stop',
        outcome: 'frequency_cap',
      })
    })
  })

  describe('"not yet" reasons defer instead of dropping', () => {
    const sp: SendWindow = { start_hour: 9, end_hour: 18, tz: 'America/Sao_Paulo' }

    it('parks a step outside the send window until the next opening', () => {
      const verdict = decideFollowupStep(
        snap({ now: new Date('2026-09-29T06:00:00Z'), window: sp }),
      )
      expect(verdict).toEqual({ kind: 'defer', until: new Date('2026-09-29T12:00:00Z') })
    })

    it('parks a snoozed thread until the snooze ends (and the window opens)', () => {
      const verdict = decideFollowupStep(
        snap({ snoozedUntil: new Date('2026-09-29T20:00:00Z'), window: sp }),
      )
      // snooze ends 17:00 São Paulo — inside the window
      expect(verdict).toEqual({ kind: 'defer', until: new Date('2026-09-29T20:00:00Z') })
    })

    it('ignores a snooze that has already ended', () => {
      expect(
        decideFollowupStep(snap({ snoozedUntil: new Date('2026-09-29T14:00:00Z') })),
      ).toEqual({ kind: 'send' })
    })

    it('a "never" beats a "not yet"', () => {
      expect(
        decideFollowupStep(
          snap({ now: new Date('2026-09-29T06:00:00Z'), window: sp, contactOptedOut: true }),
        ),
      ).toEqual({ kind: 'stop', outcome: 'opted_out' })
    })
  })
})
