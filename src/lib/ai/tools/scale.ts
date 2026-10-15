import type { SupabaseClient } from '@supabase/supabase-js'
import type { ToolDefinition, ToolExecutor } from '../types'
import { engineSendInteractiveList } from '@/lib/flows/meta-send'
import {
  groupByProfessional,
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
  type ScaleProfessional,
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
//
// From a live test (2026-10-14): free times go back to the MODEL, grouped
// by professional, so it answers in text ("Ítalo: 10h, 10h30 · Caio: 15h")
// — a list on every question hid the other professionals and arrived
// twice (the list plus the model re-typing it). A tappable list is opt-in.
// The settled location / services / day are kept on the conversation
// (migration 132) because tool results don't survive to the next turn.
// ============================================================

export interface ScaleToolContext {
  db: SupabaseClient
  client: ScaleClient
  accountId: string
  conversationId: string
  contactId: string
  userId: string
}

/** What the conversation already settled (conversations.ai_agenda_state). */
export interface AgendaState {
  unit_id?: string
  unit_name?: string
  service_ids?: string[]
  service_names?: string[]
  date?: string
  updated_at?: string
}

/** Professionals queried in parallel for "anyone" — well inside the API's burst of 120. */
const MAX_PROFESSIONALS = 12
const MAX_DAYS = 3
const TIMES_PER_PROFESSIONAL = 6
/** A settled context older than this is not handed back to the model. */
const STATE_TTL_MS = 3 * 24 * 60 * 60_000

export const SCALE_TOOLS: ToolDefinition[] = [
  {
    name: 'list_services',
    description:
      "Lists the business's locations, or the services of one location with duration and price. Call it without unit_id first: with one location you get its services directly; with several you get the locations, to ask the customer which one. Skip it when the booking context in the prompt already has the location and services. Never invent services or prices.",
    parameters: {
      type: 'object',
      properties: {
        unit_id: { type: 'string', description: 'Location id or name.' },
      },
      required: [],
    },
  },
  {
    name: 'list_professionals',
    description:
      'Lists the professionals at a location who do ALL the given services. Use when the customer asks who works there or wants a specific person.',
    parameters: {
      type: 'object',
      properties: {
        unit_id: { type: 'string', description: 'Location id or name.' },
        service_ids: { type: 'array', items: { type: 'string' }, description: 'Service ids or names.' },
      },
      required: [],
    },
  },
  {
    name: 'find_slots',
    description:
      'Real free times for the chosen services, grouped by professional, returned to YOU so you answer in your own words (e.g. "Amanhã na Aldeota: Ítalo 10h, 10h30 · Caio 15h, 16h"). Pass near_time when the customer asks about a specific time ("tem às 14h?") to get each professional\'s closest times; pass professional (id or name) when they want someone specific. Set send_list=true only when the customer should pick among many options at once — it then also sends a tappable list. Never invent availability.',
    parameters: {
      type: 'object',
      properties: {
        unit_id: { type: 'string', description: 'Location id or name. Defaults to the booking context.' },
        service_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Service ids or names. Defaults to the booking context.',
        },
        date: { type: 'string', description: '"YYYY-MM-DD". Omit to search the next few days.' },
        period: { type: 'string', enum: ['morning', 'afternoon', 'any'] },
        near_time: { type: 'string', description: '"HH:MM" the customer asked about.' },
        professional: { type: 'string', description: 'Professional id or name, only that one.' },
        send_list: { type: 'boolean', description: 'Also send a tappable list. Default false.' },
        intro_text: { type: 'string', description: 'Text above the list, only with send_list.' },
      },
      required: [],
    },
  },
  {
    name: 'book_appointment',
    description:
      'Books on the business\'s agenda. If the customer tapped a list row, the transcript shows "(id: scale|...)": pass it as slot_id. Otherwise pass professional (id or name) + date + time; location and services default to the booking context. A "conflict" result means someone just took it — offer other times. The customer\'s full name is required: pass customer_name if the CRM does not know it.',
    parameters: {
      type: 'object',
      properties: {
        slot_id: { type: 'string' },
        professional: { type: 'string', description: 'Professional id or name.' },
        unit_id: { type: 'string', description: 'Location id or name.' },
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
      'Lists the upcoming appointments this customer booked through this chat (code, date, time). Use for "qual é o meu horário?".',
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const norm = (v: string) => v.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim()

function byName<T extends { id: string; nome: string }>(list: T[], raw: string): T | undefined {
  const n = norm(raw)
  return (
    list.find((x) => x.id === raw) ??
    list.find((x) => norm(x.nome) === n) ??
    list.find((x) => norm(x.nome).includes(n)) ??
    list.find((x) => n.includes(norm(x.nome)))
  )
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

// ---------------- conversation booking context ----------------

export async function loadAgendaState(
  db: SupabaseClient,
  conversationId: string,
): Promise<AgendaState | null> {
  const { data } = await db
    .from('conversations')
    .select('ai_agenda_state')
    .eq('id', conversationId)
    .maybeSingle()
  const state = (data?.ai_agenda_state ?? null) as AgendaState | null
  if (!state?.updated_at) return state
  return Date.now() - Date.parse(state.updated_at) > STATE_TTL_MS ? null : state
}

/** Prompt line handing the settled choices back to the model. */
export function agendaStatePrompt(state: AgendaState | null): string | null {
  if (!state?.unit_id) return null
  const parts = [`location ${state.unit_name ?? ''} (id ${state.unit_id})`]
  if (state.service_ids?.length) {
    parts.push(
      `service(s) ${(state.service_names ?? []).join(', ')} (ids ${state.service_ids.join(', ')})`,
    )
  }
  if (state.date) parts.push(`day ${state.date}`)
  return (
    `Booking context already settled in this conversation: ${parts.join('; ')}. ` +
    'Use these directly — call list_services again only if the customer changes location or service.'
  )
}

async function saveState(ctx: ScaleToolContext, patch: AgendaState): Promise<void> {
  const current = (await loadAgendaState(ctx.db, ctx.conversationId)) ?? {}
  const next: AgendaState = { ...current, ...patch, updated_at: new Date().toISOString() }
  // A new location invalidates services of the old one.
  if (patch.unit_id && patch.unit_id !== current.unit_id && !patch.service_ids) {
    delete next.service_ids
    delete next.service_names
  }
  await ctx.db
    .from('conversations')
    .update({ ai_agenda_state: next })
    .eq('id', ctx.conversationId)
    .eq('account_id', ctx.accountId)
}

async function resolveUnit(
  ctx: ScaleToolContext,
  raw: string | null,
): Promise<{ id: string; name: string } | null> {
  const state = await loadAgendaState(ctx.db, ctx.conversationId)
  if (!raw && state?.unit_id) return { id: state.unit_id, name: state.unit_name ?? '' }
  if (raw && state?.unit_id === raw) return { id: raw, name: state.unit_name ?? '' }
  const units = await ctx.client.units()
  const hit = raw ? byName(units, raw) : units.length === 1 ? units[0] : undefined
  return hit ? { id: hit.id, name: hit.nome } : null
}

async function resolveServices(
  ctx: ScaleToolContext,
  unitId: string,
  raw: string[],
): Promise<{ ids: string[]; names: string[] }> {
  const state = await loadAgendaState(ctx.db, ctx.conversationId)
  if (raw.length === 0 && state?.unit_id === unitId && state.service_ids?.length) {
    return { ids: state.service_ids, names: state.service_names ?? [] }
  }
  if (raw.length > 0 && raw.every((r) => UUID_RE.test(r)) && state?.unit_id === unitId) {
    if (raw.every((r) => state.service_ids?.includes(r))) {
      return { ids: raw, names: state.service_names ?? [] }
    }
  }
  if (raw.length === 0) return { ids: [], names: [] }
  const services = await ctx.client.services(unitId)
  const hits = raw.map((r) => byName(services, r)).filter((s): s is NonNullable<typeof s> => !!s)
  return { ids: hits.map((s) => s.id), names: hits.map((s) => s.nome) }
}

async function resolveProfessional(
  ctx: ScaleToolContext,
  unitId: string,
  serviceIds: string[],
  raw: string,
): Promise<ScaleProfessional | null> {
  const pros = await ctx.client.professionals(unitId, serviceIds)
  return byName(pros, raw) ?? null
}

// ---------------- tools ----------------

async function listServices(ctx: ScaleToolContext, args: Record<string, unknown>) {
  const raw = str(args, 'unit_id')
  const unit = raw ? await resolveUnit(ctx, raw) : null
  if (!unit) {
    const units = await ctx.client.units()
    if (units.length !== 1) {
      return { units: units.map((u) => ({ id: u.id, name: u.nome, address: u.endereco ?? null })) }
    }
    return listServices(ctx, { unit_id: units[0].id })
  }
  await saveState(ctx, { unit_id: unit.id, unit_name: unit.name })
  const services = await ctx.client.services(unit.id)
  return {
    unit: { id: unit.id, name: unit.name },
    services: services.map((s) => ({
      id: s.id,
      name: s.nome,
      minutes: s.duracaoMin,
      price: priceText(s),
    })),
  }
}

async function listProfessionals(ctx: ScaleToolContext, args: Record<string, unknown>) {
  const unit = await resolveUnit(ctx, str(args, 'unit_id'))
  if (!unit) return { error: 'unit_unknown', hint: 'ask which location, or call list_services' }
  const services = await resolveServices(ctx, unit.id, ids(args, 'service_ids'))
  const pros = await ctx.client.professionals(unit.id, services.ids)
  return { unit: unit.name, professionals: pros.map((p) => ({ id: p.id, name: p.nome })) }
}

async function findSlots(ctx: ScaleToolContext, args: Record<string, unknown>) {
  const unit = await resolveUnit(ctx, str(args, 'unit_id'))
  if (!unit) return { error: 'unit_unknown', hint: 'ask which location, or call list_services' }
  const services = await resolveServices(ctx, unit.id, ids(args, 'service_ids'))
  if (services.ids.length === 0) return { error: 'service_unknown', hint: 'call list_services for this location' }

  const date = str(args, 'date')
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: 'invalid_date' }
  const today = todayLocal()
  if (date && date < today) return { error: 'date_in_past', today }

  const wanted = str(args, 'professional')
  let pros = await ctx.client.professionals(unit.id, services.ids)
  if (wanted) {
    const hit = byName(pros, wanted)
    if (!hit) return { error: 'professional_not_found', available: pros.map((p) => p.nome) }
    pros = [hit]
  }
  pros = pros.slice(0, MAX_PROFESSIONALS)
  if (pros.length === 0) return { error: 'no_professional_for_services' }

  const period = str(args, 'period')
  const nearTime = str(args, 'near_time')
  const inPeriod = (inicio: string) =>
    period === 'morning' ? slotHour(inicio) < 12 : period === 'afternoon' ? slotHour(inicio) >= 12 : true

  await saveState(ctx, {
    unit_id: unit.id,
    unit_name: unit.name,
    service_ids: services.ids,
    service_names: services.names,
    ...(date ? { date } : {}),
  })

  for (const day of daysToSearch(date, today)) {
    const byPro = await Promise.all(
      pros.map(async (p) => ({
        professional: p,
        slots: (await ctx.client.slots(p.id, day, services.ids)).slots.filter((s) => inPeriod(s.inicio)),
      })),
    )
    const grouped = groupByProfessional(byPro, { perProfessional: TIMES_PER_PROFESSIONAL, nearTime })
    if (grouped.length === 0) continue

    let listSent = false
    if (args.send_list === true) {
      const picked = pickSlots(byPro, 10)
      await engineSendInteractiveList({
        accountId: ctx.accountId,
        userId: ctx.userId,
        conversationId: ctx.conversationId,
        contactId: ctx.contactId,
        bodyText: str(args, 'intro_text') ?? 'Escolha um horário:',
        buttonLabel: 'Ver horários',
        sections: [
          {
            rows: picked.map((p) => ({
              id: scaleSlotId(p.professional.id, p.inicio, services.ids),
              title: slotLabel(p.inicio),
              description: `com ${p.professional.nome}`.slice(0, 72),
            })),
          },
        ],
        footerText: OTHER_TIME_FOOTER,
        aiGenerated: true,
      })
      listSent = true
    }
    return {
      unit: unit.name,
      services: services.names,
      date: day,
      ...(nearTime ? { near_time: nearTime } : {}),
      by_professional: grouped.map((g) => ({ name: g.name, id: g.professional_id, times: g.times })),
      list_sent: listSent,
      ...(listSent ? { note: 'The list is already on the customer\'s screen: do not repeat its times.' } : {}),
    }
  }
  return { unit: unit.name, date: date ?? null, by_professional: [], note: 'No free times found.' }
}

async function bookAppointment(ctx: ScaleToolContext, args: Record<string, unknown>) {
  const fromTap = str(args, 'slot_id') ? parseScaleSlotId(str(args, 'slot_id')!) : null
  let professionalId = fromTap?.professionalId ?? ''
  let inicio = fromTap?.inicio ?? ''
  let serviceIds = fromTap?.serviceIds ?? []
  let professionalName: string | null = null

  if (!fromTap) {
    const unit = await resolveUnit(ctx, str(args, 'unit_id'))
    if (!unit) return { error: 'unit_unknown' }
    const services = await resolveServices(ctx, unit.id, ids(args, 'service_ids'))
    if (services.ids.length === 0) return { error: 'service_unknown' }
    const rawPro = str(args, 'professional')
    if (!rawPro) return { error: 'professional_required' }
    const pro = await resolveProfessional(ctx, unit.id, services.ids, rawPro)
    if (!pro) return { error: 'professional_not_found' }
    const date = str(args, 'date')
    const time = str(args, 'time')
    if (!date || !time) return { error: 'date_and_time_required' }
    professionalId = pro.id
    professionalName = pro.nome
    serviceIds = services.ids
    inicio = `${date}T${time.padStart(5, '0')}`
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(inicio)) return { error: 'invalid_date_or_time' }

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

  const slotId = scaleSlotId(professionalId, inicio, serviceIds)
  const booking = await ctx.client.book({
    professionalId,
    serviceIds,
    inicio,
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
      professional_name: professionalName,
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
    ...(professionalName ? { professional: professionalName } : {}),
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
      professional: b.professional_name ?? null,
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
      else if (name === 'find_slots') result = await findSlots(ctx, args)
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
