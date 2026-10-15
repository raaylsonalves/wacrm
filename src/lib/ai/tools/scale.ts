import type { SupabaseClient } from '@supabase/supabase-js'
import type { ToolDefinition, ToolExecutor } from '../types'
import { engineSendInteractiveList } from '@/lib/flows/meta-send'
import {
  groupNextSlots,
  idempotencyKey,
  minuteOfDay,
  parseScaleSlotId,
  phoneDigits,
  priceText,
  scaleSlotId,
  ScaleError,
  slotHour,
  slotLabel,
  toMinute,
  type ScaleBooking,
  type ScaleClient,
  type ScaleProfessional,
} from '@/lib/scheduling/scale'
import { recordSchedulingError } from '@/lib/scheduling/integration'
import { OTHER_TIME_FOOTER } from './agenda'

// ============================================================
// Agenda tools when the account books into a partner system (ScaLE,
// migration 130) instead of wacrm's own calendar. Same contract as
// tools/agenda.ts — every failure resolves to {"error": "..."}.
//
// ScaLE API v1.1 (15/10/2026): next free times of any professional in one
// call, the customer's upcoming bookings by phone, cancellation checked
// against the phone, and the name only required for a new customer.
// Reschedule = book the new time, THEN cancel the old one (their advice:
// the customer is never left without a booking).
//
// From a live test (14/10): free times go back to the MODEL, grouped by
// professional, so it answers in text; a tappable list is opt-in. The
// settled location / services / day stay on the conversation
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

const TIMES_PER_PROFESSIONAL = 6
/** Distinct times asked of /horarios/proximos; each carries every free professional. */
const NEXT_SLOTS_LIMIT = 40
/** ± window around a time the customer asked about ("tem às 14h?"). */
const NEAR_WINDOW_MIN = 90
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
      'Real free times for the chosen services, grouped by professional, returned to YOU so you answer in your own words (e.g. "Amanhã na Aldeota: Ítalo 10h, 10h30 · Caio 15h, 16h"). Without date it looks at the next days. Pass near_time when the customer asks about a specific time ("tem às 14h?"); pass professional (id or name) when they want someone specific. Set send_list=true only when the customer should pick among many options at once — it then also sends a tappable list. Never invent availability.',
    parameters: {
      type: 'object',
      properties: {
        unit_id: { type: 'string', description: 'Location id or name. Defaults to the booking context.' },
        service_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Service ids or names. Defaults to the booking context.',
        },
        date: { type: 'string', description: '"YYYY-MM-DD". Omit to search the next days.' },
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
      'Books on the business\'s agenda. If the customer tapped a list row, the transcript shows "(id: scale|...)": pass it as slot_id. Otherwise pass professional (id or name) + date + time; location and services default to the booking context. A "conflict" result means someone just took it — offer other times. An existing customer is recognised by phone and needs no name; if the result is "customer_name_required", ask for the full name and call again with customer_name.',
    parameters: {
      type: 'object',
      properties: {
        slot_id: { type: 'string' },
        professional: { type: 'string', description: 'Professional id or name.' },
        unit_id: { type: 'string', description: 'Location id or name.' },
        service_ids: { type: 'array', items: { type: 'string' } },
        date: { type: 'string', description: '"YYYY-MM-DD"' },
        time: { type: 'string', description: '"HH:MM", the business local time.' },
        customer_name: { type: 'string', description: "Customer's full name, only if asked for." },
      },
      required: [],
    },
  },
  {
    name: 'my_appointments',
    description:
      "Lists this customer's upcoming bookings at the business (any channel), with code, date, time and whether the bot can still cancel it. Use for \"qual é o meu horário?\" and before cancelling or rescheduling.",
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'cancel_appointment',
    description:
      "Cancels one of the customer's upcoming bookings (code from my_appointments). Only after the customer clearly confirmed they want to cancel that one. If it says the booking can no longer be cancelled here, tell them to contact the business.",
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Booking code, e.g. "AG-2026-000123".' },
        reason: { type: 'string', description: "The customer's reason, if they gave one." },
      },
      required: ['code'],
    },
  },
  {
    name: 'reschedule_appointment',
    description:
      'Moves one of the customer\'s upcoming bookings (code from my_appointments) to a new time: books the new one first, then cancels the old one, so they are never left without a booking. Pass professional + date + time of the new time (same services unless they asked to change). Use only after the customer confirmed the new time.',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Code of the booking to move.' },
        professional: { type: 'string', description: 'Professional id or name for the new time.' },
        date: { type: 'string', description: '"YYYY-MM-DD"' },
        time: { type: 'string', description: '"HH:MM"' },
      },
      required: ['code', 'professional', 'date', 'time'],
    },
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

/** Today in Brazil's main zone — the partner returns local wall time. */
function todayLocal(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' })
}

const hhmm = (min: number) =>
  `${String(Math.floor(Math.min(Math.max(min, 0), 1439) / 60)).padStart(2, '0')}:${String(
    Math.min(Math.max(min, 0), 1439) % 60,
  ).padStart(2, '0')}`

/**
 * Pure: the /horarios/proximos window for what the customer asked.
 * `to` limits the START of a time (their docs).
 */
export function slotWindow(
  date: string | null,
  period: string | null,
  nearTime: string | null,
): { from?: string; to?: string } {
  if (!date) return {}
  if (nearTime) {
    const m = minuteOfDay(nearTime)
    return { from: `${date}T${hhmm(m - NEAR_WINDOW_MIN)}`, to: `${date}T${hhmm(m + NEAR_WINDOW_MIN)}` }
  }
  if (period === 'morning') return { from: `${date}T00:00`, to: `${date}T11:59` }
  if (period === 'afternoon') return { from: `${date}T12:00`, to: `${date}T23:59` }
  return { from: `${date}T00:00`, to: `${date}T23:59` }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const norm = (v: string) => v.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim()

/**
 * Id, exact name, then the CLOSEST partial match: "corte" must pick
 * "Corte Aldeota", not "Corte + Barba Aldeota" (seen in a dry run), so
 * among names containing it the shortest wins.
 */
function byName<T extends { id: string; nome: string }>(list: T[], raw: string): T | undefined {
  const n = norm(raw)
  const shortest = (xs: T[]) => [...xs].sort((a, b) => a.nome.length - b.nome.length)[0]
  return (
    list.find((x) => x.id === raw) ??
    list.find((x) => norm(x.nome) === n) ??
    shortest(list.filter((x) => norm(x.nome).includes(n))) ??
    list.find((x) => n.includes(norm(x.nome)))
  )
}

/** Exported for tests. */
export const matchByName = byName

/** API errors the model can act on; the rest become a hand-off. */
function errorResult(err: unknown): Record<string, unknown> {
  if (err instanceof ScaleError) {
    if (err.codigo === 'entrada_invalida' && err.campos?.some((c) => c.campo === 'cliente.nome')) {
      return { error: 'customer_name_required', hint: "ask the customer's full name, then call again" }
    }
    switch (err.codigo) {
      case 'conflito':
        return { error: 'conflict' }
      case 'regra_de_negocio':
        return { error: 'time_unavailable_or_started', hint: 'offer another time, or the business handles it' }
      case 'nao_encontrado':
        return { error: 'not_found', hint: 'look it up again' }
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
  if (
    raw.length > 0 &&
    raw.every((r) => UUID_RE.test(r)) &&
    state?.unit_id === unitId &&
    raw.every((r) => state.service_ids?.includes(r))
  ) {
    return { ids: raw, names: state.service_names ?? [] }
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

/** The customer's phone as the partner reads it. wa_user_id is not a phone. */
async function customerPhone(ctx: ScaleToolContext): Promise<{ phone: string | null; name: string | null }> {
  const { data } = await ctx.db
    .from('contacts')
    .select('name, phone')
    .eq('id', ctx.contactId)
    .eq('account_id', ctx.accountId)
    .maybeSingle()
  return { phone: phoneDigits(data?.phone as string | null), name: (data?.name as string | null) ?? null }
}

async function recordBooking(ctx: ScaleToolContext, b: ScaleBooking, professionalName: string | null) {
  const { error } = await ctx.db.from('external_bookings').upsert(
    {
      account_id: ctx.accountId,
      provider: 'scale',
      external_id: b.id,
      code: b.codigo,
      conversation_id: ctx.conversationId,
      contact_id: ctx.contactId,
      unit_id: b.unidadeId,
      professional_id: b.barbeiroId,
      ...(professionalName ? { professional_name: professionalName } : {}),
      services: b.servicoIds,
      starts_local: b.inicio,
      ends_local: b.fim,
      status: b.status,
    },
    { onConflict: 'account_id,provider,external_id' },
  )
  if (error) console.error('[ai scale tools] could not record booking:', error.message)
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

  let professional: ScaleProfessional | null = null
  const wanted = str(args, 'professional')
  if (wanted) {
    professional = await resolveProfessional(ctx, unit.id, services.ids, wanted)
    if (!professional) {
      const pros = await ctx.client.professionals(unit.id, services.ids)
      return { error: 'professional_not_found', available: pros.map((p) => p.nome) }
    }
  }

  const period = str(args, 'period')
  const nearTime = str(args, 'near_time')
  await saveState(ctx, {
    unit_id: unit.id,
    unit_name: unit.name,
    service_ids: services.ids,
    service_names: services.names,
    ...(date ? { date } : {}),
  })

  // One call for every professional (API v1.1), instead of one per
  // professional per day.
  const { slots } = await ctx.client.nextSlots({
    unitId: unit.id,
    serviceIds: services.ids,
    professionalId: professional?.id,
    ...slotWindow(date, period, nearTime),
    limit: NEXT_SLOTS_LIMIT,
  })
  // Without a date the window is "the next days"; still honour the period.
  const inPeriod = (inicio: string) =>
    date || (period !== 'morning' && period !== 'afternoon')
      ? true
      : period === 'morning'
        ? slotHour(inicio) < 12
        : slotHour(inicio) >= 12
  const usable = slots.filter((s) => inPeriod(s.inicio))
  if (usable.length === 0) {
    return { unit: unit.name, date, by_professional: [], note: 'No free times in this window.' }
  }

  let listSent = false
  if (args.send_list === true) {
    const rows = usable.slice(0, 10).map((s) => {
      const pro = s.barbeiros[0]
      return {
        id: scaleSlotId(pro.id, s.inicio, services.ids),
        title: slotLabel(s.inicio),
        description: `com ${s.barbeiros.map((b) => b.nome).join(', ')}`.slice(0, 72),
      }
    })
    await engineSendInteractiveList({
      accountId: ctx.accountId,
      userId: ctx.userId,
      conversationId: ctx.conversationId,
      contactId: ctx.contactId,
      bodyText: str(args, 'intro_text') ?? 'Escolha um horário:',
      buttonLabel: 'Ver horários',
      sections: [{ rows }],
      footerText: OTHER_TIME_FOOTER,
      aiGenerated: true,
    })
    listSent = true
  }

  const grouped = groupNextSlots(usable, TIMES_PER_PROFESSIONAL)
  return {
    unit: unit.name,
    services: services.names,
    ...(nearTime ? { near_time: nearTime } : {}),
    by_professional: grouped.map((g) => ({
      name: g.name,
      id: g.professional_id,
      times: g.times.map((t) => (date ? t.time : `${t.date} ${t.time}`)),
    })),
    list_sent: listSent,
    ...(listSent ? { note: "The list is already on the customer's screen: do not repeat its times." } : {}),
  }
}

async function bookOne(
  ctx: ScaleToolContext,
  target: { professionalId: string; inicio: string; serviceIds: string[]; professionalName: string | null },
  customerName: string | null,
) {
  const { phone } = await customerPhone(ctx)
  if (!phone) return { error: 'customer_phone_unknown', handoff: true }
  const slotId = scaleSlotId(target.professionalId, target.inicio, target.serviceIds)
  const booking = await ctx.client.book({
    professionalId: target.professionalId,
    serviceIds: target.serviceIds,
    inicio: target.inicio,
    // Only needed for a new customer (API v1.1); an existing one is
    // recognised by phone and the name is ignored.
    name: customerName,
    phone,
    idempotencyKey: idempotencyKey(ctx.conversationId, slotId),
  })
  await recordBooking(ctx, booking, target.professionalName)
  return { booking }
}

async function resolveTarget(ctx: ScaleToolContext, args: Record<string, unknown>) {
  const fromTap = str(args, 'slot_id') ? parseScaleSlotId(str(args, 'slot_id')!) : null
  if (fromTap) return { ...fromTap, professionalName: null }
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
  const inicio = `${date}T${time.padStart(5, '0')}`
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(inicio)) return { error: 'invalid_date_or_time' }
  return { professionalId: pro.id, inicio, serviceIds: services.ids, professionalName: pro.nome }
}

async function bookAppointment(ctx: ScaleToolContext, args: Record<string, unknown>) {
  const target = await resolveTarget(ctx, args)
  if ('error' in target) return target
  const out = await bookOne(ctx, target, str(args, 'customer_name'))
  if ('error' in out) return out
  const b = out.booking
  return {
    booked: true,
    code: b.codigo,
    date: b.inicio.slice(0, 10),
    time: b.inicio.slice(11, 16),
    minutes: b.duracaoMin,
    ...(target.professionalName ? { professional: target.professionalName } : {}),
  }
}

async function upcoming(ctx: ScaleToolContext): Promise<ScaleBooking[] | { error: string; handoff?: boolean }> {
  const { phone } = await customerPhone(ctx)
  if (!phone) return { error: 'customer_phone_unknown', handoff: true }
  return ctx.client.customerBookings(phone)
}

async function myAppointments(ctx: ScaleToolContext) {
  const list = await upcoming(ctx)
  if (!Array.isArray(list)) return list
  // Professional names we know from bookings made here.
  const { data: known } = await ctx.db
    .from('external_bookings')
    .select('external_id, professional_name')
    .eq('account_id', ctx.accountId)
    .in('external_id', list.map((b) => b.id).length ? list.map((b) => b.id) : ['-'])
  const names = new Map((known ?? []).map((k) => [k.external_id as string, k.professional_name as string | null]))
  return {
    appointments: list.map((b) => ({
      code: b.codigo,
      date: toMinute(b.inicio).slice(0, 10),
      time: toMinute(b.inicio).slice(11, 16),
      professional: names.get(b.id) ?? null,
      can_cancel: b.cancelavel !== false,
    })),
  }
}

async function findByCode(ctx: ScaleToolContext, code: string) {
  const list = await upcoming(ctx)
  if (!Array.isArray(list)) return list
  const n = code.trim().toUpperCase()
  const hit = list.find((b) => b.codigo.toUpperCase() === n || b.id === code.trim())
  return hit ?? { error: 'booking_not_found', hint: 'call my_appointments' }
}

async function cancelAppointment(ctx: ScaleToolContext, args: Record<string, unknown>) {
  const code = str(args, 'code')
  if (!code) return { error: 'code_required' }
  const b = await findByCode(ctx, code)
  if ('error' in b) return b
  if (b.cancelavel === false) return { error: 'cannot_cancel_here', hint: 'the customer must contact the business' }
  const { phone } = await customerPhone(ctx)
  const done = await ctx.client.cancel(b.id, phone!, str(args, 'reason') ?? undefined)
  await ctx.db
    .from('external_bookings')
    .update({ status: done.status })
    .eq('account_id', ctx.accountId)
    .eq('external_id', b.id)
  return { cancelled: true, code: done.codigo }
}

async function rescheduleAppointment(ctx: ScaleToolContext, args: Record<string, unknown>) {
  const code = str(args, 'code')
  if (!code) return { error: 'code_required' }
  const old = await findByCode(ctx, code)
  if ('error' in old) return old
  if (old.cancelavel === false) return { error: 'cannot_change_here', hint: 'the customer must contact the business' }

  // Same location and services as the booking being moved.
  const pro = await resolveProfessional(ctx, old.unidadeId, old.servicoIds, str(args, 'professional') ?? '')
  if (!pro) return { error: 'professional_not_found' }
  const date = str(args, 'date')
  const time = str(args, 'time')
  if (!date || !time) return { error: 'date_and_time_required' }

  // New first, then cancel the old one: never leave them without a booking.
  const out = await bookOne(
    ctx,
    { professionalId: pro.id, inicio: `${date}T${time.padStart(5, '0')}`, serviceIds: old.servicoIds, professionalName: pro.nome },
    null,
  )
  if ('error' in out) return out
  const { phone } = await customerPhone(ctx)
  try {
    const done = await ctx.client.cancel(old.id, phone!, 'remarcado pelo WhatsApp')
    await ctx.db
      .from('external_bookings')
      .update({ status: done.status })
      .eq('account_id', ctx.accountId)
      .eq('external_id', old.id)
  } catch (err) {
    console.error('[ai scale tools] reschedule: new booked, old not cancelled:', err)
    return {
      rescheduled: false,
      new_code: out.booking.codigo,
      warning: 'The new time is booked but the old one could not be cancelled — tell the customer the team will cancel the old one.',
      handoff: true,
    }
  }
  return {
    rescheduled: true,
    new_code: out.booking.codigo,
    date: out.booking.inicio.slice(0, 10),
    time: out.booking.inicio.slice(11, 16),
    professional: pro.nome,
    old_code: old.codigo,
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
      else if (name === 'cancel_appointment') result = await cancelAppointment(ctx, args)
      else if (name === 'reschedule_appointment') result = await rescheduleAppointment(ctx, args)
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
