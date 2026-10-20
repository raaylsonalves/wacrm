import { describe, it, expect } from 'vitest'
import { agendaClockText, isWithinBusinessHours, localToday } from './agenda-clock'

const S = {
  timezone: 'America/Sao_Paulo',
  work_days: [1, 2, 3, 4, 5],
  day_start: '09:00:00',
  day_end: '18:00',
}

describe('agendaClockText', () => {
  it("states today's local date, weekday and the bookable hours", () => {
    // 12:48Z = 09:48 in São Paulo, Thursday 2026-10-01
    const t = agendaClockText(new Date('2026-10-01T12:48:00Z'), S)
    expect(t).toContain('Thursday, 2026-10-01 09:48 (America/Sao_Paulo)')
    expect(t).toContain('Monday, Tuesday, Wednesday, Thursday, Friday, between 09:00 and 18:00')
  })
  it('uses the local day near midnight, not the UTC one', () => {
    expect(localToday(new Date('2026-10-02T01:00:00Z'), S.timezone)).toBe('2026-10-01')
  })
})

describe('isWithinBusinessHours', () => {
  it('rejects 08:00, accepts 09:00 and the last full slot', () => {
    expect(isWithinBusinessHours(new Date('2026-10-02T11:00:00Z'), 30, S)).toBe(false) // 08:00
    expect(isWithinBusinessHours(new Date('2026-10-02T12:00:00Z'), 30, S)).toBe(true) // 09:00
    expect(isWithinBusinessHours(new Date('2026-10-02T20:30:00Z'), 30, S)).toBe(true) // 17:30
    expect(isWithinBusinessHours(new Date('2026-10-02T20:45:00Z'), 30, S)).toBe(false) // runs past 18:00
  })
  it('rejects a day off', () => {
    expect(isWithinBusinessHours(new Date('2026-10-03T13:00:00Z'), 30, S)).toBe(false) // Saturday
  })
})

describe('agendaClockText open/closed', () => {
  const S = { timezone: 'America/Fortaleza', work_days: [1, 2, 3, 4, 5, 6], day_start: '09:00', day_end: '20:00' }
  it('is open in the afternoon', () => {
    // Tue 2026-10-20 15:00 Fortaleza
    expect(agendaClockText(new Date('2026-10-20T18:00:00Z'), S)).toContain('open now (until 20:00')
  })
  it('after closing it opens tomorrow', () => {
    // Tue 2026-10-20 20:10 Fortaleza
    expect(agendaClockText(new Date('2026-10-20T23:10:00Z'), S)).toContain('opens tomorrow at 09:00')
  })
  it('Saturday night opens Monday', () => {
    // Sat 2026-10-24 21:00 Fortaleza
    expect(agendaClockText(new Date('2026-10-25T00:00:00Z'), S)).toContain('opens Monday at 09:00')
  })
  it('early morning opens today', () => {
    expect(agendaClockText(new Date('2026-10-20T10:00:00Z'), S)).toContain('opens today at 09:00')
  })
})
