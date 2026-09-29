// ============================================================
// Prospecting campaign rules (specs/prospecting-csv-import.md, part B).
// Pure — the pacing, window, warm-up and validation decisions live here
// so they can be tested without a database or a clock.
// ============================================================

export type ChannelKind = 'waha' | 'cloud'

export interface CampaignConfig {
  channel_kind: ChannelKind
  /** WAHA channel id (waha only). */
  channel_id: string | null
  /** The agent that writes the approach (waha) and answers replies (both). */
  agent_id: string
  pipeline_id: string
  entry_stage_id: string
  qualified_stage_id: string
  /** What we offer and the tone (waha approach). */
  instruction: string
  /** What the agent must confirm before qualifying. */
  criteria: string
  /** Cloud only: an approved template and its body variables. */
  template_name: string | null
  template_language: string | null
  /** One token per body variable: 'name' | 'company' | 'first_name' | literal text. */
  template_params: string[]
  daily_limit: number
  interval_minutes: number
  /** Local sending window, hours [start, end), and weekdays (0 = Sunday). */
  window_start_hour: number
  window_end_hour: number
  weekdays: number[]
  timezone: string
  legal_basis_ref: string
}

export const DEFAULTS = {
  daily_limit: 10,
  interval_minutes: 15,
  window_start_hour: 9,
  window_end_hour: 18,
  weekdays: [1, 2, 3, 4, 5],
  timezone: 'America/Sao_Paulo',
}

const clampInt = (v: unknown, min: number, max: number, dflt: number) => {
  const n = Math.floor(Number(v))
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt
}
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '')
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Validate a submitted config. Returns the normalized config or the first
 *  problem as a short code the UI translates. */
export function parseCampaignConfig(
  raw: Record<string, unknown>,
): { ok: true; config: CampaignConfig } | { ok: false; error: string } {
  const kind = raw.channel_kind === 'waha' ? 'waha' : raw.channel_kind === 'cloud' ? 'cloud' : null
  if (!kind) return { ok: false, error: 'channel_required' }
  const channelId = str(raw.channel_id, 64)
  if (kind === 'waha' && !UUID.test(channelId)) return { ok: false, error: 'channel_required' }
  for (const k of ['agent_id', 'pipeline_id', 'entry_stage_id', 'qualified_stage_id'] as const) {
    if (!UUID.test(str(raw[k], 64))) return { ok: false, error: `${k}_required` }
  }
  if (raw.entry_stage_id === raw.qualified_stage_id) return { ok: false, error: 'stages_must_differ' }
  const instruction = str(raw.instruction, 2000)
  const criteria = str(raw.criteria, 2000)
  if (kind === 'waha' && instruction.length < 10) return { ok: false, error: 'instruction_required' }
  if (criteria.length < 10) return { ok: false, error: 'criteria_required' }
  const templateName = str(raw.template_name, 200)
  if (kind === 'cloud' && !templateName) return { ok: false, error: 'template_required' }
  const legal = str(raw.legal_basis_ref, 1000)
  if (legal.length < 10) return { ok: false, error: 'legal_basis_required' }

  const start = clampInt(raw.window_start_hour, 0, 23, DEFAULTS.window_start_hour)
  const end = clampInt(raw.window_end_hour, 1, 24, DEFAULTS.window_end_hour)
  if (end <= start) return { ok: false, error: 'window_invalid' }
  const weekdays = Array.isArray(raw.weekdays)
    ? [...new Set(raw.weekdays.map((d) => Math.floor(Number(d))).filter((d) => d >= 0 && d <= 6))]
    : DEFAULTS.weekdays
  if (weekdays.length === 0) return { ok: false, error: 'window_invalid' }

  return {
    ok: true,
    config: {
      channel_kind: kind,
      channel_id: kind === 'waha' ? channelId : null,
      agent_id: str(raw.agent_id, 64),
      pipeline_id: str(raw.pipeline_id, 64),
      entry_stage_id: str(raw.entry_stage_id, 64),
      qualified_stage_id: str(raw.qualified_stage_id, 64),
      instruction,
      criteria,
      template_name: kind === 'cloud' ? templateName : null,
      template_language: kind === 'cloud' ? str(raw.template_language, 20) || null : null,
      template_params: Array.isArray(raw.template_params)
        ? raw.template_params.map((p) => str(p, 200)).slice(0, 10)
        : [],
      daily_limit: clampInt(raw.daily_limit, 1, 50, DEFAULTS.daily_limit),
      interval_minutes: clampInt(raw.interval_minutes, 5, 1440, DEFAULTS.interval_minutes),
      window_start_hour: start,
      window_end_hour: end,
      weekdays,
      timezone: str(raw.timezone, 64) || DEFAULTS.timezone,
      legal_basis_ref: legal,
    },
  }
}

/** Local hour + weekday of `now` in a timezone. */
function localParts(now: Date, timezone: string): { hour: number; weekday: number } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    hourCycle: 'h23',
    weekday: 'short',
  })
  const parts = fmt.formatToParts(now)
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0)
  const wd = parts.find((p) => p.type === 'weekday')?.value ?? 'Sun'
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(wd)
  return { hour, weekday }
}

export function isInSendingWindow(now: Date, c: Pick<CampaignConfig, 'window_start_hour' | 'window_end_hour' | 'weekdays' | 'timezone'>): boolean {
  const { hour, weekday } = localParts(now, c.timezone)
  return c.weekdays.includes(weekday) && hour >= c.window_start_hour && hour < c.window_end_hour
}

/** Next instant (on the hour) that is inside the window; searches a week. */
export function nextWindowOpening(now: Date, c: Pick<CampaignConfig, 'window_start_hour' | 'window_end_hour' | 'weekdays' | 'timezone'>): Date {
  const t = new Date(now)
  t.setUTCMinutes(0, 0, 0)
  for (let i = 0; i < 24 * 8; i++) {
    t.setUTCHours(t.getUTCHours() + 1)
    if (isInSendingWindow(t, c)) return t
  }
  return new Date(now.getTime() + 24 * 3600_000)
}

/**
 * Daily ceiling for a WAHA number by age. A fresh number sending many cold
 * first-touches on day one is the pattern that gets it banned; the ceiling
 * grows with the number's age. The official API has no warm-up ceiling
 * (Meta enforces its own tiers).
 */
export function warmupCeiling(kind: ChannelKind, connectedAt: string | null, now: Date): number {
  if (kind === 'cloud') return Number.POSITIVE_INFINITY
  if (!connectedAt) return 5
  const days = (now.getTime() - new Date(connectedAt).getTime()) / 86_400_000
  if (days < 3) return 5
  if (days < 7) return 10
  if (days < 14) return 20
  if (days < 30) return 35
  return 50
}

/** When to send the next one: the operator's interval plus jitter that
 *  only DELAYS (up to +50%) — a fixed cadence is a robot signature, and
 *  the jitter must never break the minimum the operator set. */
export function nextSendAt(now: Date, intervalMinutes: number, random: number = Math.random()): Date {
  const r = Math.min(Math.max(random, 0), 1)
  const ms = intervalMinutes * 60_000 * (1 + 0.5 * r)
  return new Date(now.getTime() + ms)
}

export interface ContactFields {
  name: string | null
  company: string | null
}

/** Template variable tokens → text. Known tokens read the contact; anything
 *  else is sent literally. An empty value becomes a neutral fallback, since
 *  Meta rejects an empty parameter. */
export function renderTemplateParams(tokens: string[], contact: ContactFields): string[] {
  const first = (contact.name ?? '').trim().split(/\s+/)[0] ?? ''
  return tokens.map((tok) => {
    const t = tok.trim()
    const v =
      t === '{{name}}' || t === 'name'
        ? contact.name
        : t === '{{first_name}}' || t === 'first_name'
          ? first
          : t === '{{company}}' || t === 'company'
            ? contact.company
            : t
    return (v ?? '').trim() || '-'
  })
}

/** Appended by code, never requested from the model: the customer's only
 *  other exit is "report spam", which the system can't see and which
 *  burns the number. The isolated word is what opt-out.ts recognises. */
export const OPT_OUT_LINE: Record<string, string> = {
  pt: 'Se não quiser receber mais mensagens, responda SAIR.',
  en: 'If you would rather not hear from us, reply STOP.',
  es: 'Si no quieres recibir más mensajes, responde SALIR.',
  ko: '더 이상 메시지를 받고 싶지 않으시면 STOP이라고 답장해 주세요.',
}

export function optOutLine(locale: string | undefined): string {
  return OPT_OUT_LINE[(locale ?? 'en').slice(0, 2)] ?? OPT_OUT_LINE.en
}

/** Fixed by the product (not editable): transparent, short, no invented
 *  familiarity. The campaign instruction is the business's part. */
export function buildApproachPrompt(args: {
  instruction: string
  criteria: string
  contact: ContactFields
  businessContext: string | null
}): string {
  return [
    'You write the FIRST WhatsApp message a business sends to a potential customer who has never talked to it.',
    'Rules: 2 to 4 short sentences; greet by first name when known; say plainly who is writing and why, in one line; ' +
      'NEVER claim the person filled a form, asked for contact, showed interest, or that you met; never invent results, prices or familiarity; ' +
      'end with ONE simple question that invites a reply. Write in the language of the business context. Output only the message text.',
    'Do not add an opt-out line; it is appended automatically.',
    `What we offer and how to sound:\n${args.instruction}`,
    `Things to confirm later in the conversation (do not ask them all now):\n${args.criteria}`,
    args.businessContext ? `Business context:\n${args.businessContext}` : '',
    `Recipient: name=${args.contact.name ?? 'unknown'}; company=${args.contact.company ?? 'unknown'}.`,
  ]
    .filter(Boolean)
    .join('\n\n')
}

/** Errors that stop the whole campaign vs just this candidate. Unknown
 *  errors stop the campaign: pausing one that could continue costs a
 *  resume click; not pausing one that should stop costs the whole list. */
export function failureScope(code: string): 'candidate' | 'campaign' {
  return ['contact_opted_out', 'bad_request', 'empty_reply', 'invalid_phone', 'recipient'].includes(code)
    ? 'candidate'
    : 'campaign'
}
