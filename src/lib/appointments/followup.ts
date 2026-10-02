// Pure helpers for the post-appointment message (migration 102), sent by
// /api/appointments/cron. No I/O so the window and params are tested.

const DAY_MS = 86_400_000

/**
 * Bookings whose start is between `days + GRACE_DAYS` and `days` ago are
 * due. The lower bound keeps a freshly enabled setting (or a raised
 * day count) from messaging every customer of the last months at once,
 * while still covering a cron that was down for a few days.
 */
export const FOLLOWUP_GRACE_DAYS = 7

export function followupWindow(now: Date, daysAfter: number): { from: Date; to: Date } {
  const to = new Date(now.getTime() - daysAfter * DAY_MS)
  return { from: new Date(to.getTime() - FOLLOWUP_GRACE_DAYS * DAY_MS), to }
}

/** Number of distinct {{n}} placeholders in a template body. */
export function templateVarCount(body: string | null | undefined): number {
  return new Set((body ?? '').match(/\{\{\s*\d+\s*\}\}/g) ?? []).size
}

/**
 * Body params for the follow-up: {{1}} is the customer's first name. A
 * template with more variables can't be filled here — the settings
 * dialog only offers templates with at most one.
 */
export function followupParams(body: string | null | undefined, name: string | null | undefined): string[] {
  if (templateVarCount(body) === 0) return []
  const first = (name ?? '').trim().split(/\s+/)[0]
  return [first || 'cliente']
}
