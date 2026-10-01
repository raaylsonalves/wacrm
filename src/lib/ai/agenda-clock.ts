import { localParts } from '@/lib/appointments/slots'

// ============================================================
// What the model needs to know to book anything: today's date and the
// business hours. Seen live: with neither in the prompt, "amanhã" became
// 2025-05-20 (a guess from training data), offer_slots answered
// date_in_past and the model handed the customer off.
// ============================================================

export interface ClockSettings {
  timezone: string
  work_days: number[] // 0 = Sunday
  day_start: string // "HH:MM" or "HH:MM:SS"
  day_end: string
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const pad = (n: number) => String(n).padStart(2, '0')
const hhmm = (s: string) => s.slice(0, 5)

function localWeekday(p: { year: number; month: number; day: number }): number {
  return new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay()
}

/** One prompt line: today's date/time and the bookable hours. */
export function agendaClockText(now: Date, s: ClockSettings): string {
  const p = localParts(now, s.timezone)
  const days = [...s.work_days]
    .sort((a, b) => a - b)
    .map((d) => WEEKDAYS[d])
    .join(', ')
  return (
    `Right now it is ${WEEKDAYS[localWeekday(p)]}, ${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)} (${s.timezone}). ` +
    'Work out "today", "tomorrow", weekdays and dates from this — never guess a year or date. ' +
    `Appointments can only be booked on ${days || 'no days'}, between ${hhmm(s.day_start)} and ${hhmm(s.day_end)}. ` +
    'If the customer asks for a time outside that, say so kindly and offer the nearest times that work.'
  )
}

function minutesOf(clock: string): number {
  const [h, m] = clock.split(':').map(Number)
  return (h || 0) * 60 + (m || 0)
}

/** Whether [start, start+duration) sits inside one business day. */
export function isWithinBusinessHours(start: Date, durationMinutes: number, s: ClockSettings): boolean {
  const p = localParts(start, s.timezone)
  if (!s.work_days.includes(localWeekday(p))) return false
  const from = p.hour * 60 + p.minute
  return from >= minutesOf(s.day_start) && from + durationMinutes <= minutesOf(s.day_end)
}

/** "2026-10-01" in the business timezone — returned with date errors. */
export function localToday(now: Date, timezone: string): string {
  const p = localParts(now, timezone)
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`
}
