// ============================================================
// Follow-up sequences — the pure rules (specs/followup-sequences.md).
//
// No I/O in here: every "should we still send this?" question is a
// function of a snapshot, so the truth table is unit-testable and the
// DB module only has to load the snapshot. The send-time check is the
// source of truth for stopping; the SQL triggers (migration 073) are
// cleanup, so a race between "cron claimed the wait" and "customer
// replied" is decided HERE, at the last moment before a message leaves.
// ============================================================

export type SilenceUnit = 'minutes' | 'hours' | 'days'

export interface SendWindow {
  start_hour: number
  end_hour: number
  tz: string
  /** 0 = Sunday … 6 = Saturday, in `tz`. Omitted = every day. */
  days?: number[]
}

export interface SilenceConfig {
  silence_after: { amount: number; unit: SilenceUnit }
  /** `ai_conversations` (default) also requires the bot to still own the thread. */
  audience: 'ai_conversations' | 'all_open'
  /** Ignore conversations idle longer than this. */
  max_age_days: number
  send_window?: SendWindow
  /** `cancel` (default): a human owning the thread ends the sequence. */
  handoff_policy: 'cancel' | 'allow'
  /** What happens when the sequence ran out unanswered (migration 115). */
  on_exhaust: OnExhaust
}

/**
 * Actions once the last step went out and the customer stayed quiet for
 * one more silence interval. Any combination; `notify` is on by default
 * so a cold lead is never silent to the team.
 */
export interface OnExhaust {
  /** Notify the conversation's team (assignee, else responsibles/agents). */
  notify: boolean
  /** Take the AI off the thread so it lands in "waiting for a person". */
  handoff: boolean
  /** Tag the contact (e.g. "Sem resposta"). */
  tag_id: string | null
  /** Close the conversation (it reopens if the customer writes back). */
  close: boolean
}

export const DEFAULT_ON_EXHAUST: OnExhaust = {
  notify: true,
  handoff: false,
  tag_id: null,
  close: false,
}

export function parseOnExhaust(raw: unknown): OnExhaust {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_ON_EXHAUST }
  const o = raw as Record<string, unknown>
  return {
    notify: o.notify !== false,
    handoff: o.handoff === true,
    tag_id: typeof o.tag_id === 'string' && o.tag_id ? o.tag_id : null,
    close: o.close === true,
  }
}

export type ExhaustVerdict =
  /** Still inside the grace interval after the last step. */
  | 'wait'
  /** The customer answered after all: nothing to do. */
  | 'replied'
  /** Quiet through the grace interval: run the actions. */
  | 'act'

/**
 * Whether an exhausted enrollment's actions are due. The grace interval
 * is the automation's own silence: the last follow-up gets the same time
 * to be answered as the conversation got before the first one.
 */
export function decideExhaust(s: {
  episodeAt: Date
  lastCustomerMessageAt: Date | null
  endedAt: Date
  now: Date
  cfg: SilenceConfig
}): ExhaustVerdict {
  if (
    s.lastCustomerMessageAt &&
    s.lastCustomerMessageAt.getTime() !== s.episodeAt.getTime()
  ) {
    return 'replied'
  }
  const grace = s.cfg.silence_after.amount * UNIT_MS[s.cfg.silence_after.unit]
  return s.now.getTime() - s.endedAt.getTime() >= grace ? 'act' : 'wait'
}

export type FollowupOutcome =
  | 'replied'
  | 'exhausted'
  | 'handoff'
  | 'opted_out'
  | 'closed'
  | 'window_closed'
  | 'frequency_cap'
  | 'automation_off'
  | 'not_deliverable'

export const MIN_SILENCE_MINUTES = 5
export const DEFAULT_MAX_AGE_DAYS = 14
/** Per contact, across ALL sequences, per rolling 7 days. */
export const FOLLOWUP_WEEKLY_CAP = 3
export const FOLLOWUP_CAP_WINDOW_MS = 7 * 24 * 3_600_000
/** WhatsApp Cloud API free-form window after the customer's last message. */
export const SESSION_WINDOW_MS = 24 * 3_600_000

const UNIT_MS: Record<SilenceUnit, number> = {
  minutes: 60_000,
  hours: 3_600_000,
  days: 86_400_000,
}

/**
 * Read a stored `trigger_config` defensively. Returns null when it can't
 * describe a sweep (so a half-edited automation is skipped, not run with
 * a guessed silence).
 */
export function parseSilenceConfig(raw: unknown): SilenceConfig | null {
  if (!raw || typeof raw !== 'object') return null
  const c = raw as Record<string, unknown>
  const sa = c.silence_after as Record<string, unknown> | undefined
  if (!sa || typeof sa.amount !== 'number' || !Number.isFinite(sa.amount)) return null
  if (sa.unit !== 'minutes' && sa.unit !== 'hours' && sa.unit !== 'days') return null
  if (sa.amount * UNIT_MS[sa.unit] < MIN_SILENCE_MINUTES * 60_000) return null

  const maxAge =
    typeof c.max_age_days === 'number' && c.max_age_days > 0
      ? c.max_age_days
      : DEFAULT_MAX_AGE_DAYS

  return {
    silence_after: { amount: sa.amount, unit: sa.unit },
    audience: c.audience === 'all_open' ? 'all_open' : 'ai_conversations',
    max_age_days: maxAge,
    send_window: parseSendWindow(c.send_window),
    handoff_policy: c.handoff_policy === 'allow' ? 'allow' : 'cancel',
    on_exhaust: parseOnExhaust(c.on_exhaust),
  }
}

function parseSendWindow(raw: unknown): SendWindow | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const w = raw as Record<string, unknown>
  const s = w.start_hour
  const e = w.end_hour
  if (typeof s !== 'number' || typeof e !== 'number') return undefined
  if (!Number.isInteger(s) || !Number.isInteger(e)) return undefined
  if (s < 0 || s > 23 || e < 0 || e > 24 || s === e) return undefined
  const tz = typeof w.tz === 'string' && isValidTimeZone(w.tz) ? w.tz : 'UTC'
  const days = Array.isArray(w.days)
    ? w.days.filter((d): d is number => Number.isInteger(d) && d >= 0 && d <= 6)
    : undefined
  return { start_hour: s, end_hour: e, tz, days: days && days.length > 0 ? days : undefined }
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

/** The two instants bounding a sweep: silent since at least `silentBefore`,
 *  but not so old that reviving it would be strange. */
export function sweepBounds(
  cfg: SilenceConfig,
  now: Date,
): { silentBefore: Date; notOlderThan: Date } {
  const silenceMs = cfg.silence_after.amount * UNIT_MS[cfg.silence_after.unit]
  return {
    silentBefore: new Date(now.getTime() - silenceMs),
    notOlderThan: new Date(now.getTime() - cfg.max_age_days * 86_400_000),
  }
}

// ------------------------------------------------------------
// Send window
// ------------------------------------------------------------

/** Hour (0-23) and weekday (0=Sun) of an instant, in a time zone. */
export function zonedParts(date: Date, tz: string): { hour: number; weekday: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: 'numeric',
    hourCycle: 'h23',
    weekday: 'short',
  }).formatToParts(date)
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0)
  const wd = parts.find((p) => p.type === 'weekday')?.value ?? 'Sun'
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(wd)
  return { hour, weekday: weekday < 0 ? 0 : weekday }
}

export function isInSendWindow(date: Date, w: SendWindow | undefined): boolean {
  if (!w) return true
  const { hour, weekday } = zonedParts(date, w.tz)
  if (w.days && !w.days.includes(weekday)) return false
  // start > end wraps midnight (e.g. 22 → 6).
  return w.start_hour < w.end_hour
    ? hour >= w.start_hour && hour < w.end_hour
    : hour >= w.start_hour || hour < w.end_hour
}

/**
 * When a step due at `date` may actually go out: `date` itself inside the
 * window, otherwise the next whole hour that is. Walked hour by hour
 * (≤ 8 days) rather than computed, so DST shifts and odd windows can't
 * produce an off-by-one; falls back to +24h for a window that never opens
 * (e.g. `days` empty after filtering).
 */
export function nextSendTime(date: Date, w: SendWindow | undefined): Date {
  if (isInSendWindow(date, w)) return date
  const hour = 3_600_000
  let t = new Date(Math.ceil(date.getTime() / hour) * hour)
  if (t.getTime() === date.getTime()) t = new Date(t.getTime() + hour)
  for (let i = 0; i < 24 * 8; i++) {
    if (isInSendWindow(t, w)) return t
    t = new Date(t.getTime() + hour)
  }
  return new Date(date.getTime() + 24 * hour)
}

// ------------------------------------------------------------
// The send-time decision
// ------------------------------------------------------------

export interface GuardSnapshot {
  now: Date
  enrollmentActive: boolean
  /** The customer message that started this episode. */
  episodeAt: Date
  /** The customer's latest message now — moved on = they replied. */
  lastCustomerMessageAt: Date | null
  contactOptedOut: boolean
  conversationStatus: string
  snoozedUntil: Date | null
  /** A person owns the thread AND the sequence's policy is `cancel`. */
  humanOwnsAndPolicyCancels: boolean
  /** NULL `whatsapp_channel_id` = Cloud API, which has the 24h window. */
  isCloudApi: boolean
  stepIsTemplate: boolean
  sendsInCapWindow: number
  weeklyCap: number
  window: SendWindow | undefined
}

export type GuardVerdict =
  | { kind: 'send' }
  /** End the enrollment; `outcome` is null when it had already ended. */
  | { kind: 'stop'; outcome: FollowupOutcome | null }
  /** Not now — park until `until`. */
  | { kind: 'defer'; until: Date }

/**
 * Should this follow-up step still go out? Checked immediately before
 * EVERY send of a follow-up run. Order is severity: things that mean
 * "never" (replied, opted out, closed, a person took over, window shut,
 * cap reached) come before things that mean "not yet" (snoozed, outside
 * the send window).
 */
export function decideFollowupStep(s: GuardSnapshot): GuardVerdict {
  if (!s.enrollmentActive) return { kind: 'stop', outcome: null }

  if (
    s.lastCustomerMessageAt &&
    s.lastCustomerMessageAt.getTime() !== s.episodeAt.getTime()
  ) {
    return { kind: 'stop', outcome: 'replied' }
  }
  if (s.contactOptedOut) return { kind: 'stop', outcome: 'opted_out' }
  if (s.conversationStatus === 'closed') return { kind: 'stop', outcome: 'closed' }
  if (s.humanOwnsAndPolicyCancels) return { kind: 'stop', outcome: 'handoff' }

  // A doomed send to Meta is noise: outside 24h only an approved template
  // may go, and a free-form step ends the sequence rather than erroring.
  if (
    s.isCloudApi &&
    !s.stepIsTemplate &&
    s.lastCustomerMessageAt &&
    s.now.getTime() - s.lastCustomerMessageAt.getTime() > SESSION_WINDOW_MS
  ) {
    return { kind: 'stop', outcome: 'window_closed' }
  }
  if (s.sendsInCapWindow >= s.weeklyCap) {
    return { kind: 'stop', outcome: 'frequency_cap' }
  }

  if (s.snoozedUntil && s.snoozedUntil.getTime() > s.now.getTime()) {
    return { kind: 'defer', until: nextSendTime(s.snoozedUntil, s.window) }
  }
  if (!isInSendWindow(s.now, s.window)) {
    return { kind: 'defer', until: nextSendTime(s.now, s.window) }
  }
  return { kind: 'send' }
}
