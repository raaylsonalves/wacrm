import type { SupabaseClient } from '@supabase/supabase-js'
import type { ToolDefinition, ToolExecutor } from '../types'
import {
  localParts,
  zonedToUtc,
  generateFreeSlots,
  formatDateTime,
  formatSlotLabel,
  slotReplyId,
  parseSlotReplyId,
} from '@/lib/appointments/slots'
import { loadAppointmentSettings, loadBusyRanges } from '@/lib/appointments/store'
import { engineSendInteractiveList } from '@/lib/flows/meta-send'

// ============================================================
// Agenda tools for the AI auto-reply agent (specs/ai-agenda-tool-
// calling.md). Mirrors the offer_slots Flow node's logic
// (src/lib/flows/engine.ts's offerSlotsAndSuspend / bookOfferedSlot)
// but has no flow_run to hang state off — each call is self-contained,
// booking to the shared calendar only (assigned_to: null). v1 has
// exactly these two tools; a third reuses this same plumbing.
// ============================================================

export interface AgendaToolContext {
  db: SupabaseClient
  accountId: string
  conversationId: string
  contactId: string
  /** Author for the outgoing WhatsApp send's audit columns — the
   *  account's AI config owner, mirroring how Flow/automation sends
   *  pass through their own owning user. */
  userId: string
}

export const AGENDA_TOOLS: ToolDefinition[] = [
  {
    name: 'offer_slots',
    description:
      "Looks up real free time slots on the business's shared appointment calendar and sends them to the customer as a tappable WhatsApp list. Use this when the customer is vague about timing (a day period, \"this week\", no exact time) or when you want them to pick from multiple real options. Never invent availability yourself — always call this instead of guessing free times.",
    parameters: {
      type: 'object',
      properties: {
        date: {
          type: 'string',
          description:
            'Exact day the customer asked about, "YYYY-MM-DD". Omit for a rolling search instead of one specific day.',
        },
        period: {
          type: 'string',
          enum: ['morning', 'afternoon', 'any'],
          description: 'Restrict to morning or afternoon slots. Default "any".',
        },
        days_ahead: {
          type: 'integer',
          description: 'How many days forward to search when "date" is omitted. Default 7.',
        },
        duration_minutes: {
          type: 'integer',
          description: "Appointment length in minutes. Defaults to the business's configured slot length.",
        },
        max_options: {
          type: 'integer',
          description: 'Max slots to show, up to 10. Default 5.',
        },
        intro_text: {
          type: 'string',
          description:
            "Short WhatsApp message body shown above the list, written in the customer's own language and matching the conversation's tone.",
        },
        button_label: {
          type: 'string',
          description: 'Label of the button that opens the list, at most 20 characters.',
        },
      },
      required: ['intro_text', 'button_label'],
    },
  },
  {
    name: 'book_appointment',
    description:
      'Creates the appointment on the shared calendar. Use with slot_id when the customer just tapped one of your offer_slots options — the transcript shows their tap as "... (id: slot:...)"; pass that id verbatim. Use date+time instead when the customer named an exact day and time you have not already shown as a list — this call is itself the availability check; a "conflict" result means it was taken right before you booked it.',
    parameters: {
      type: 'object',
      properties: {
        slot_id: {
          type: 'string',
          description:
            'The exact id from an offer_slots result, or from the customer tapping a list row, e.g. "slot:2026-09-25T12:00:00.000Z".',
        },
        date: {
          type: 'string',
          description: '"YYYY-MM-DD", used only when slot_id is not available.',
        },
        time: {
          type: 'string',
          description: '"HH:MM" in the business local time, used only when slot_id is not available.',
        },
        duration_minutes: {
          type: 'integer',
          description: "Appointment length in minutes. Defaults to the business's configured slot length.",
        },
        title: {
          type: 'string',
          description: 'Short appointment title, e.g. what the customer is coming in for.',
        },
      },
      required: [],
    },
  },
]

function jsonResult(value: unknown): string {
  return JSON.stringify(value)
}

function str(args: Record<string, unknown>, key: string): string | null {
  const v = args[key]
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

function positiveInt(args: Record<string, unknown>, key: string): number | null {
  const v = args[key]
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), max)
}

function parseDateStr(s: string): { year: number; month: number; day: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (!m) return null
  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  return { year, month, day }
}

function parseTimeStr(s: string): { hour: number; minute: number } | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s)
  if (!m) return null
  const hour = Number(m[1])
  const minute = Number(m[2])
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null
  return { hour, minute }
}

/** Days between two Y/M/D triples, ignoring time of day — the same
 *  "day offset from now" `generateFreeSlots` scans over. */
function daysBetween(
  from: { year: number; month: number; day: number },
  to: { year: number; month: number; day: number },
): number {
  const a = Date.UTC(from.year, from.month - 1, from.day)
  const b = Date.UTC(to.year, to.month - 1, to.day)
  return Math.round((b - a) / 86_400_000)
}

async function executeOfferSlots(
  ctx: AgendaToolContext,
  args: Record<string, unknown>,
): Promise<string> {
  const settings = await loadAppointmentSettings(ctx.db, ctx.accountId)
  const now = new Date()
  const duration = positiveInt(args, 'duration_minutes') ?? settings.slot_minutes
  const maxOptions = clamp(positiveInt(args, 'max_options') ?? 5, 1, 10)

  const dateArg = str(args, 'date')
  let targetDate: { year: number; month: number; day: number } | null = null
  let daysAhead: number

  if (dateArg) {
    targetDate = parseDateStr(dateArg)
    if (!targetDate) return jsonResult({ error: 'invalid_date' })
    const today = localParts(now, settings.timezone)
    daysAhead = daysBetween(today, targetDate)
    if (daysAhead < 0) return jsonResult({ error: 'date_in_past' })
    if (daysAhead > 365) return jsonResult({ error: 'date_too_far' })
  } else {
    daysAhead = clamp(positiveInt(args, 'days_ahead') ?? 7, 1, 60)
  }

  const busy = await loadBusyRanges(
    ctx.db,
    ctx.accountId,
    null,
    now,
    new Date(now.getTime() + (daysAhead + 1) * 86_400_000),
  )

  let slots = generateFreeSlots({
    now,
    settings,
    busy,
    daysAhead,
    // A single-day search still scans every day up to it (generateFreeSlots
    // has no "only this day" mode) — ask for a generous cap, then filter
    // down to the target day below, rather than changing that shared,
    // tested helper for this one caller.
    limit: targetDate ? 500 : maxOptions,
    durationMinutes: duration,
  })

  if (targetDate) {
    const target = targetDate
    slots = slots.filter((s) => {
      const p = localParts(s, settings.timezone)
      return p.year === target.year && p.month === target.month && p.day === target.day
    })
  }

  const period = str(args, 'period')
  if (period === 'morning' || period === 'afternoon') {
    slots = slots.filter((s) => {
      const hour = localParts(s, settings.timezone).hour
      return period === 'morning' ? hour < 12 : hour >= 12
    })
  }

  slots = slots.slice(0, maxOptions)

  if (slots.length === 0) {
    return jsonResult({ sent: false, slots: [] })
  }

  const introText = str(args, 'intro_text') ?? 'Encontrei esses horários livres:'
  const buttonLabel = (str(args, 'button_label') ?? 'Ver horários').slice(0, 20)
  const slotInfo = slots.map((s) => ({
    id: slotReplyId(s),
    label: formatSlotLabel(s, settings.timezone),
  }))

  // Always sends the list, even for a single slot — same as the Flow
  // node (offerSlotsAndSuspend), one code path instead of a special case.
  await engineSendInteractiveList({
    accountId: ctx.accountId,
    userId: ctx.userId,
    conversationId: ctx.conversationId,
    contactId: ctx.contactId,
    bodyText: introText,
    buttonLabel,
    sections: [{ rows: slotInfo.map((s) => ({ id: s.id, title: s.label })) }],
    aiGenerated: true,
  })

  return jsonResult({ sent: true, count: slotInfo.length, slots: slotInfo })
}

async function executeBookAppointment(
  ctx: AgendaToolContext,
  args: Record<string, unknown>,
): Promise<string> {
  const settings = await loadAppointmentSettings(ctx.db, ctx.accountId)
  const duration = positiveInt(args, 'duration_minutes') ?? settings.slot_minutes

  let start: Date | null = null
  const slotId = str(args, 'slot_id')
  if (slotId) {
    start = parseSlotReplyId(slotId)
  } else {
    const dateArg = str(args, 'date')
    const timeArg = str(args, 'time')
    const d = dateArg ? parseDateStr(dateArg) : null
    const t = timeArg ? parseTimeStr(timeArg) : null
    if (d && t) {
      start = zonedToUtc(d.year, d.month, d.day, t.hour, t.minute, settings.timezone)
    }
  }

  if (!start || start.getTime() <= Date.now()) {
    return jsonResult({ error: 'invalid_or_past_time' })
  }

  const end = new Date(start.getTime() + duration * 60_000)
  const { date, time } = formatDateTime(start, settings.timezone)
  const title = str(args, 'title') ?? formatSlotLabel(start, settings.timezone)

  const { error } = await ctx.db.from('appointments').insert({
    account_id: ctx.accountId,
    contact_id: ctx.contactId,
    conversation_id: ctx.conversationId,
    assigned_to: null,
    title,
    starts_at: start.toISOString(),
    ends_at: end.toISOString(),
    source: 'ai',
  })

  if (error) {
    if ((error as { code?: string }).code === '23P01') {
      return jsonResult({ error: 'conflict' })
    }
    console.error('[ai agenda tools] book_appointment insert failed:', error)
    return jsonResult({ error: 'booking_failed' })
  }

  return jsonResult({ booked: true, date, time, title })
}

/** Runs one of `AGENDA_TOOLS` by name. Every failure — bad args, a
 *  thrown error, an unknown tool name — resolves to a `{"error": "..."}"`
 *  string rather than rejecting, so a malformed model call degrades to
 *  the model reacting in text instead of the whole reply crashing. */
export function createAgendaToolExecutor(ctx: AgendaToolContext): ToolExecutor {
  return async (name, args) => {
    const tag = `[ai agenda tools ${ctx.conversationId}] ${name}`
    const startedAt = Date.now()
    console.info(`${tag} called`, args)
    try {
      let result: string
      if (name === 'offer_slots') result = await executeOfferSlots(ctx, args)
      else if (name === 'book_appointment') result = await executeBookAppointment(ctx, args)
      else result = jsonResult({ error: `unknown_tool:${name}` })
      console.info(`${tag} done in ${Date.now() - startedAt}ms —`, result)
      return result
    } catch (err) {
      console.error(`${tag} failed after ${Date.now() - startedAt}ms:`, err)
      return jsonResult({ error: 'internal_error' })
    }
  }
}
