import type { SupabaseClient } from '@supabase/supabase-js'
import type { ToolDefinition, ToolExecutor } from '../types'
import { engineSendInteractiveList } from '@/lib/flows/meta-send'
import {
  idempotencyKey,
  parseScaleSlotId,
  phoneDigits,
  pickSlots,
  priceText,
  scaleSlotId,
  ScaleError,
  slotHour,
  slotLabel,
  type ScaleClient,
} from '@/lib/scheduling/scale'
import { recordSchedulingError } from '@/lib/scheduling/integration'
import { OTHER_TIME_FOOTER } from './agenda'

// ============================================================
// Agenda tools when the account books into a partner system (ScaLE,
// migration 130) instead of wacrm's own calendar. Same contract as
// tools/agenda.ts — every failure resolves to {"error": "..."} — but the
// agenda lives on the partner's side: units → services → professionals
// → free times → book. v1 of their API cannot cancel or reschedule, so
// those go to a person.
// ============================================================

export interface ScaleToolContext {
  db: SupabaseClient
  client: ScaleClient
  accountId: string
  conversationId: string
  contactId: string
  userId: string
}

const DEFAULT_OFFERED = 4
/** Professionals queried in parallel for "anyone" — well inside the API's burst of 120. */
const MAX_PROFESSIONALS = 12
const MAX_DAYS = 3

export const SCALE_TOOLS: ToolDefinition[] = [
  {
    name: 'list_services',
    description:
      "Lists the business's locations, or the services of one location with duration and price. Call it without unit_id first: if there is only one location you get its services directly; if there are several you get the locations to ask the customer which one. Never invent services or prices — use this.",
    parameters: {
      type: 'object',
      properties: {
        unit_id: { type: 'string', description: 'Location id from a previous list_services result.' },
      },
      required: [],
    },
  },
  {
    name: 'list_professionals',
    description:
      'Lists the professionals at a location who do ALL the given services. Use when the customer asks who is available or wants a specific person.',
    parameters: {
      type: 'object',
      properties: {
        unit_id: { type: 'string' },
        service_ids: { type: 'array', items: { type: 'string' } },
      },
      required: ['unit_id', 'service_ids'],
    },
  },
  {
    name: 'offer_slots',
    description:
      'Looks up real free times for the chosen services and sends a few as a tappable WhatsApp list (each row shows the time and the professional; a footer says they can ask for another day). Pass professional_id only when the customer asked for someone specific; otherwise any professional who does the services is considered. Never invent availability.',
    parameters: {
      type: 'object',
      properties: {
        unit_id: { type: 'string' },
        service_ids: { type: 'array', items: { type: 'string' } },
        date: {
          type: 'string',
          description: 'Day the customer asked about, "YYYY-MM-DD". Omit to search the next few days.',
        },
        period: { type: 'string', enum: ['morning', 'afternoon', 'any'] },
        professional_id: { type: 'string', description: 'Only this professional.' },
        max_options: { type: 'integer', description: 'Up to 10. Default 4.' },
        intro_text: {
          type: 'string',
          description:
            "Short message above the list in the customer's language, presented as suggestions (e.g. \"Tenho esses horários na sexta:\").",
        },
        button_label: { type: 'string', description: 'Button label, at most 20 characters.' },
      },
      required: ['unit_id', 'service_ids', 'intro_text', 'button_label'],
    },
  },
  {
    name: 'book_appointment',
    description:
      'Books on the business\'s agenda. When the customer tapped one of your offer_slots rows the transcript shows "(id: scale|...)": pass that id verbatim as slot_id. Otherwise pass professional_id + date + time + service_ids. A "conflict" result means someone just took it — offer other times. The customer\'s name is required: pass customer_name if the CRM does not know it yet.',
    parameters: {
      type: 'object',
      properties: {
        slot_id: { type: 'string' },
        professional_id: { type: 'string' },
        service_ids: { type: 'array', items: { type: 'string' } },
        date: { type: 'string', description: '"YYYY-MM-DD"' },
        time: { type: 'string', description: '"HH:MM", the business local time.' },
        customer_name: { type: 'string', description: "Customer's full name, if known from the chat." },
      },
      required: [],
    },
  },
  {
    name: 'my_appointments',
    description:
      'Lists the upcoming appointments this customer booked through this chat (code, date, time, professional). Use for "qual é o meu horário?".',
    parameters: { type: 'object', properties: {}, required: [] },
  },
]

const json = (v: unknown) => JSON.stringify(v)

function str(args: Record<string, unknown>, key: string): string | null {
  const v = args[key]
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

function ids(args: Record<string, unknown>, key: string): string[] {
  const v = args[key]
  const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : []
  return list.map((x) => String(x).trim()).filter(Boolean)
}

/** "YYYY-MM-DD" days to search, in the shop's local calendar. */
function daysToSearch(date: string | null, todayLocal: string): string[] {
  if (date) return [date]
  const [y, m, d] = todayLocal.split('-').map(Number)
  return Array.from({ length: MAX_DAYS }, (_, i) =>
    new Date(Date.UTC(y, m - 1, d + i)).toISOString().slice(0, 10),
  )
}

/** Today in Brazil's main zone — the partner returns local wall time. */
function todayLocal(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' })
}

/** API errors the model can act on; the rest become a hand-off. */
function errorResult(err: unknown): Record<string, unknown> {
  if (err instanceof ScaleError) {
    switch (err.codigo) {
      case 'conflito':
        return { error: 'conflict' }
      case 'regra_de_negocio':
        return { error: 'time_unavailable' }
      case 'nao_encontrado':
        return { error: 'not_found', hint: 'list the options again' }
      case 'entrada_invalida':
        return { error: 'invalid_input', fields: err.campos ?? [] }
      default:
        return { error: 'agenda_unavailable', handoff: true }
    }
  }
  return { error: 'agenda_unavailable', handoff: true }
}

async function listServices(ctx: ScaleToolContext, args: Record<string, unknown>) {
  let unitId = str(args, 'unit_id')
  if (!unitId) {
    const units = await ctx.client.units()
    if (units.length !== 1) {
      return { units: units.map((u) => ({ id: u.id, name: u.nome, address: u.endereco ?? null })) }
    }
    unitId = units[0].id
  }
  const services = await ctx.client.services(unitId)
  return {
    unit_id: unitId,
    services: services.map((s) => ({
      id: s.id,
      name: s.nome,
      minutes: s.duracaoMin,
      price: priceText(s),
    })),
  }
}

async function listProfessionals(ctx: ScaleToolContext, args: Record<string, unknown>) {
  const unitId = str(args, 'unit_id')
  if (!unitId) return { error: 'unit_id_required' }
  const pros = await ctx.client.professionals(unitId, ids(args, 'service_ids'))
  return { professionals: pros.map((p) => ({ id: p.id, name: p.nome })) }
}

async function offerSlots(ctx: ScaleToolContext, args: Record<string, unknown>) {
  const unitId = str(args, 'unit_id')
  const serviceIds = ids(args, 'service_ids')
  if (!unitId || serviceIds.length === 0) return { error: 'unit_and_services_required' }
  const date = str(args, 'date')
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: 'invalid_date' }
  const today = todayLocal()
  if (date && date < today) return { error: 'date_in_past', today }
  const max = Math.min(Math.max(Number(args.max_options) || DEFAULT_OFFERED, 1), 10)

  const wanted = str(args, 'professional_id')
  const pros = (await ctx.client.professionals(unitId, serviceIds))
    .filter((p) => !wanted || p.id === wanted)
    .slice(0, MAX_PROFESSIONALS)
  if (pros.length === 0) return { sent: false, error: 'no_professional_for_services' }

  const period = str(args, 'period')
  let picked: ReturnType<typeof pickSlots> = []
  for (const day of daysToSearch(date, today)) {
    const byPro = await Promise.all(
      pros.map(async (p) => {
        const { slots } = await ctx.client.slots(p.id, day, serviceIds)
        return {
          professional: p,
          slots: slots.filter((s) => {
            if (period !== 'morning' && period !== 'afternoon') return true
            return period === 'morning' ? slotHour(s.inicio) < 12 : slotHour(s.inicio) >= 12
          }),
        }
      }),
    )
    picked = [...picked, ...pickSlots(byPro, max - picked.length)]
    if (picked.length >= max) break
  }
  if (picked.length === 0) return { sent: false, slots: [] }

  const rows = picked.map((p) => ({
    id: scaleSlotId(p.professional.id, p.inicio, serviceIds),
    title: slotLabel(p.inicio),
    description: `com ${p.professional.nome}`.slice(0, 72),
  }))
  await engineSendInteractiveList({
    accountId: ctx.accountId,
    userId: ctx.userId,
    conversationId: ctx.conversationId,
    contactId: ctx.contactId,
    bodyText: str(args, 'intro_text') ?? 'Encontrei esses horários livres:',
    buttonLabel: (str(args, 'button_label') ?? 'Ver horários').slice(0, 20),
    sections: [{ rows }],
    footerText: OTHER_TIME_FOOTER,
    aiGenerated: true,
  })
  return { sent: true, slots: rows.map((r) => ({ id: r.id, label: `${r.title} ${r.description}` })) }
}

async function bookAppointment(ctx: ScaleToolContext, args: Record<string, unknown>) {
  const parsed = str(args, 'slot_id') ? parseScaleSlotId(str(args, 'slot_id')!) : null
  const date = str(args, 'date')
  const time = str(args, 'time')
  const target = parsed ?? {
    professionalId: str(args, 'professional_id') ?? '',
    inicio: date && time ? `${date}T${time.padStart(5, '0')}` : '',
    serviceIds: ids(args, 'service_ids'),
  }
  if (!target.professionalId || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(target.inicio) || target.serviceIds.length === 0) {
    return { error: 'need_slot_id_or_professional_date_time_services' }
  }

  const { data: contact } = await ctx.db
    .from('contacts')
    .select('name, phone, wa_user_id')
    .eq('id', ctx.contactId)
    .eq('account_id', ctx.accountId)
    .maybeSingle()
  const name = (str(args, 'customer_name') ?? contact?.name ?? '').trim()
  if (name.length < 2) return { error: 'customer_name_required' }
  const phone = phoneDigits(contact?.phone) ?? phoneDigits(contact?.wa_user_id)
  if (!phone) return { error: 'customer_phone_unknown', handoff: true }

  const slotId = scaleSlotId(target.professionalId, target.inicio, target.serviceIds)
  const booking = await ctx.client.book({
    professionalId: target.professionalId,
    serviceIds: target.serviceIds,
    inicio: target.inicio,
    name,
    phone,
    idempotencyKey: idempotencyKey(ctx.conversationId, slotId),
  })

  // Best-effort history for the CRM; the booking itself already exists.
  const { error } = await ctx.db.from('external_bookings').upsert(
    {
      account_id: ctx.accountId,
      provider: 'scale',
      external_id: booking.id,
      code: booking.codigo,
      conversation_id: ctx.conversationId,
      contact_id: ctx.contactId,
      unit_id: booking.unidadeId,
      professional_id: booking.barbeiroId,
      services: booking.servicoIds,
      starts_local: booking.inicio,
      ends_local: booking.fim,
      status: booking.status,
    },
    { onConflict: 'account_id,provider,external_id' },
  )
  if (error) console.error('[ai scale tools] could not record booking:', error.message)

  return {
    booked: true,
    code: booking.codigo,
    date: booking.inicio.slice(0, 10),
    time: booking.inicio.slice(11, 16),
    minutes: booking.duracaoMin,
  }
}

async function myAppointments(ctx: ScaleToolContext) {
  const now = new Date().toLocaleString('sv-SE', { timeZone: 'America/Sao_Paulo' }).replace(' ', 'T')
  const { data } = await ctx.db
    .from('external_bookings')
    .select('code, starts_local, professional_name, status')
    .eq('account_id', ctx.accountId)
    .eq('contact_id', ctx.contactId)
    .gte('starts_local', now)
    .order('starts_local')
    .limit(5)
  return {
    appointments: (data ?? []).map((b) => ({
      code: b.code,
      date: String(b.starts_local).slice(0, 10),
      time: String(b.starts_local).slice(11, 16),
      status: b.status,
    })),
    note: 'Only bookings made through this chat. Cancelling or rescheduling is done by the team.',
  }
}

export function createScaleToolExecutor(ctx: ScaleToolContext): ToolExecutor {
  return async (name, args) => {
    const tag = `[ai scale tools ${ctx.conversationId}] ${name}`
    const startedAt = Date.now()
    try {
      let result: unknown
      if (name === 'list_services') result = await listServices(ctx, args)
      else if (name === 'list_professionals') result = await listProfessionals(ctx, args)
      else if (name === 'offer_slots') result = await offerSlots(ctx, args)
      else if (name === 'book_appointment') result = await bookAppointment(ctx, args)
      else if (name === 'my_appointments') result = await myAppointments(ctx)
      else result = { error: `unknown_tool:${name}` }
      console.info(`${tag} done in ${Date.now() - startedAt}ms`)
      return json(result)
    } catch (err) {
      const out = errorResult(err)
      console.error(`${tag} failed after ${Date.now() - startedAt}ms:`, err instanceof Error ? err.message : err)
      if (out.handoff && err instanceof ScaleError) {
        await recordSchedulingError(ctx.db, ctx.accountId, `${err.codigo}: ${err.message}`).catch(() => {})
      }
      return json(out)
    }
  }
}
