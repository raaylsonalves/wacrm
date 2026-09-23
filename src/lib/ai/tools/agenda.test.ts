import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const h = vi.hoisted(() => ({
  engineSendInteractiveList: vi.fn(),
}))

vi.mock('@/lib/flows/meta-send', () => ({
  engineSendInteractiveList: h.engineSendInteractiveList,
}))

import { AGENDA_TOOLS, createAgendaToolExecutor } from './agenda'

const DEFAULT_SETTINGS_ROW = {
  timezone: 'America/Sao_Paulo',
  work_days: [1, 2, 3, 4, 5],
  day_start: '09:00',
  day_end: '18:00',
  slot_minutes: 30,
  reminder_enabled: true,
  reminder_hours_before: 24,
  reminder_text: 'x',
}

/** Minimal fake matching the query chains `loadAppointmentSettings` /
 *  `loadBusyRanges` / book_appointment's insert / reschedule_appointment's
 *  lookup+update issue against. The two `appointments` SELECT shapes are
 *  told apart by their column list, same as the real callers use
 *  different ones (`loadBusyRanges` selects `starts_at, ends_at`;
 *  the reschedule lookup selects `id, starts_at, ends_at`). */
function fakeDb(opts: {
  settingsRow?: Record<string, unknown> | null
  busyRows?: { starts_at: string; ends_at: string }[]
  insertError?: { code?: string; message?: string } | null
  insertedRows?: Record<string, unknown>[]
  existingAppointment?: { id: string; starts_at: string; ends_at: string } | null
  updateError?: { code?: string; message?: string } | null
  updatedRows?: { id: string; patch: Record<string, unknown> }[]
}): SupabaseClient {
  const insertedRows = opts.insertedRows ?? []
  const updatedRows = opts.updatedRows ?? []
  return {
    from(table: string) {
      if (table === 'appointment_settings') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () =>
                Promise.resolve({ data: opts.settingsRow ?? DEFAULT_SETTINGS_ROW, error: null }),
            }),
          }),
        }
      }
      if (table === 'appointments') {
        return {
          select: (columns: string) => {
            if (columns.includes('id')) {
              // reschedule_appointment lookup:
              //   select('id, starts_at, ends_at').eq().eq().neq().gt().order().limit().maybeSingle()
              return {
                eq: () => ({
                  eq: () => ({
                    neq: () => ({
                      gt: () => ({
                        order: () => ({
                          limit: () => ({
                            maybeSingle: () =>
                              Promise.resolve({
                                data: opts.existingAppointment ?? null,
                                error: null,
                              }),
                          }),
                        }),
                      }),
                    }),
                  }),
                }),
              }
            }
            // loadBusyRanges: select('starts_at, ends_at').eq().neq().lt().gt().eq()/.is()
            return {
              eq: () => ({
                neq: () => ({
                  lt: () => ({
                    gt: () => ({
                      eq: () => Promise.resolve({ data: opts.busyRows ?? [], error: null }),
                      is: () => Promise.resolve({ data: opts.busyRows ?? [], error: null }),
                    }),
                  }),
                }),
              }),
            }
          },
          insert: (row: Record<string, unknown>) => {
            insertedRows.push(row)
            return Promise.resolve({ error: opts.insertError ?? null })
          },
          update: (patch: Record<string, unknown>) => ({
            eq: (_col: string, id: string) => {
              updatedRows.push({ id, patch })
              return Promise.resolve({ error: opts.updateError ?? null })
            },
          }),
        }
      }
      throw new Error(`fakeDb: unexpected table ${table}`)
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

beforeEach(() => {
  h.engineSendInteractiveList.mockReset()
  h.engineSendInteractiveList.mockResolvedValue({ whatsapp_message_id: 'wamid.1' })
})

const CTX = { accountId: 'acc-1', conversationId: 'conv-1', contactId: 'contact-1', userId: 'user-1' }

describe('AGENDA_TOOLS', () => {
  it('defines exactly offer_slots, book_appointment, and reschedule_appointment', () => {
    expect(AGENDA_TOOLS.map((t) => t.name)).toEqual([
      'offer_slots',
      'book_appointment',
      'reschedule_appointment',
    ])
  })
})

describe('offer_slots', () => {
  it('rejects an unparsable date', async () => {
    const executor = createAgendaToolExecutor({ db: fakeDb({}), ...CTX })
    const result = JSON.parse(
      await executor('offer_slots', {
        date: 'next thursday',
        intro_text: 'Horários:',
        button_label: 'Ver',
      }),
    )
    expect(result).toEqual({ error: 'invalid_date' })
    expect(h.engineSendInteractiveList).not.toHaveBeenCalled()
  })

  it('rejects a date in the past', async () => {
    const executor = createAgendaToolExecutor({ db: fakeDb({}), ...CTX })
    const result = JSON.parse(
      await executor('offer_slots', {
        date: '2020-01-01',
        intro_text: 'Horários:',
        button_label: 'Ver',
      }),
    )
    expect(result).toEqual({ error: 'date_in_past' })
  })

  it('reports no slots without sending anything when the calendar is fully busy', async () => {
    // Business hours 09:00-09:30 only, a single slot, already busy.
    const settingsRow = { ...DEFAULT_SETTINGS_ROW, day_start: '09:00', day_end: '09:30' }
    const future = new Date()
    future.setUTCFullYear(future.getUTCFullYear() + 1)
    const busy = [
      { starts_at: '2000-01-01T00:00:00.000Z', ends_at: '2999-01-01T00:00:00.000Z' },
    ]
    const executor = createAgendaToolExecutor({
      db: fakeDb({ settingsRow, busyRows: busy }),
      ...CTX,
    })
    const result = JSON.parse(
      await executor('offer_slots', { intro_text: 'Horários:', button_label: 'Ver' }),
    )
    expect(result).toEqual({ sent: false, slots: [] })
    expect(h.engineSendInteractiveList).not.toHaveBeenCalled()
  })

  it('sends an interactive list and reports the offered slots when free', async () => {
    const executor = createAgendaToolExecutor({ db: fakeDb({ busyRows: [] }), ...CTX })
    const result = JSON.parse(
      await executor('offer_slots', {
        days_ahead: 14,
        max_options: 3,
        intro_text: 'Horários livres:',
        button_label: 'Escolher',
      }),
    )
    expect(result.sent).toBe(true)
    expect(result.count).toBeGreaterThan(0)
    expect(result.slots[0]).toHaveProperty('id')
    expect(result.slots[0].id).toMatch(/^slot:/)
    expect(h.engineSendInteractiveList).toHaveBeenCalledTimes(1)
    const call = h.engineSendInteractiveList.mock.calls[0][0]
    expect(call.accountId).toBe('acc-1')
    expect(call.conversationId).toBe('conv-1')
    expect(call.aiGenerated).toBe(true)
    expect(call.bodyText).toBe('Horários livres:')
  })
})

describe('book_appointment', () => {
  it('rejects when neither slot_id nor date+time resolve to a valid future time', async () => {
    const executor = createAgendaToolExecutor({ db: fakeDb({}), ...CTX })
    const result = JSON.parse(await executor('book_appointment', {}))
    expect(result).toEqual({ error: 'invalid_or_past_time' })
  })

  it('rejects a past slot_id', async () => {
    const executor = createAgendaToolExecutor({ db: fakeDb({}), ...CTX })
    const result = JSON.parse(
      await executor('book_appointment', { slot_id: 'slot:2000-01-01T12:00:00.000Z' }),
    )
    expect(result).toEqual({ error: 'invalid_or_past_time' })
  })

  it('books a future slot_id, inserting the right account/contact/source', async () => {
    const insertedRows: Record<string, unknown>[] = []
    const executor = createAgendaToolExecutor({
      db: fakeDb({ insertedRows }),
      ...CTX,
    })
    const future = new Date(Date.now() + 3 * 86_400_000).toISOString()
    const result = JSON.parse(await executor('book_appointment', { slot_id: `slot:${future}` }))
    expect(result.booked).toBe(true)
    expect(insertedRows).toHaveLength(1)
    expect(insertedRows[0]).toMatchObject({
      account_id: 'acc-1',
      contact_id: 'contact-1',
      conversation_id: 'conv-1',
      assigned_to: null,
      source: 'ai',
      starts_at: future,
    })
  })

  it('books an exact date+time when slot_id is absent', async () => {
    const insertedRows: Record<string, unknown>[] = []
    const executor = createAgendaToolExecutor({ db: fakeDb({ insertedRows }), ...CTX })
    const future = new Date()
    future.setUTCFullYear(future.getUTCFullYear() + 1)
    const y = future.getUTCFullYear()
    const result = JSON.parse(
      await executor('book_appointment', { date: `${y}-06-15`, time: '10:00', title: 'Reunião' }),
    )
    expect(result.booked).toBe(true)
    expect(insertedRows[0]).toMatchObject({ title: 'Reunião', source: 'ai' })
  })

  it('maps a 23P01 exclusion violation to a conflict result', async () => {
    const executor = createAgendaToolExecutor({
      db: fakeDb({ insertError: { code: '23P01', message: 'conflict' } }),
      ...CTX,
    })
    const future = new Date(Date.now() + 3 * 86_400_000).toISOString()
    const result = JSON.parse(await executor('book_appointment', { slot_id: `slot:${future}` }))
    expect(result).toEqual({ error: 'conflict' })
  })
})

describe('reschedule_appointment', () => {
  it('reports no_appointment_found when the contact has no upcoming booking', async () => {
    const executor = createAgendaToolExecutor({
      db: fakeDb({ existingAppointment: null }),
      ...CTX,
    })
    const future = new Date(Date.now() + 3 * 86_400_000).toISOString()
    const result = JSON.parse(
      await executor('reschedule_appointment', { slot_id: `slot:${future}` }),
    )
    expect(result).toEqual({ error: 'no_appointment_found' })
  })

  it('moves the existing appointment via UPDATE, not a new insert', async () => {
    const existing = {
      id: 'appt-1',
      starts_at: '2026-09-24T12:40:00.000Z',
      ends_at: '2026-09-24T13:25:00.000Z',
    }
    const updatedRows: { id: string; patch: Record<string, unknown> }[] = []
    const insertedRows: Record<string, unknown>[] = []
    const executor = createAgendaToolExecutor({
      db: fakeDb({ existingAppointment: existing, updatedRows, insertedRows }),
      ...CTX,
    })
    const future = new Date(Date.now() + 5 * 86_400_000).toISOString()
    const result = JSON.parse(
      await executor('reschedule_appointment', { slot_id: `slot:${future}` }),
    )
    expect(result.rescheduled).toBe(true)
    expect(updatedRows).toHaveLength(1)
    expect(updatedRows[0].id).toBe('appt-1')
    expect(updatedRows[0].patch.starts_at).toBe(future)
    // The 45-minute length of the original booking carries over since
    // no duration_minutes was passed.
    expect(updatedRows[0].patch.ends_at).toBe(
      new Date(new Date(future).getTime() + 45 * 60_000).toISOString(),
    )
    expect(insertedRows).toHaveLength(0)
  })

  it('rejects an invalid or past new time without touching the existing row', async () => {
    const updatedRows: { id: string; patch: Record<string, unknown> }[] = []
    const executor = createAgendaToolExecutor({
      db: fakeDb({
        existingAppointment: {
          id: 'appt-1',
          starts_at: '2026-09-24T12:40:00.000Z',
          ends_at: '2026-09-24T13:10:00.000Z',
        },
        updatedRows,
      }),
      ...CTX,
    })
    const result = JSON.parse(
      await executor('reschedule_appointment', { slot_id: 'slot:2000-01-01T12:00:00.000Z' }),
    )
    expect(result).toEqual({ error: 'invalid_or_past_time' })
    expect(updatedRows).toHaveLength(0)
  })

  it('maps a 23P01 exclusion violation on the new time to a conflict result', async () => {
    const executor = createAgendaToolExecutor({
      db: fakeDb({
        existingAppointment: {
          id: 'appt-1',
          starts_at: '2026-09-24T12:40:00.000Z',
          ends_at: '2026-09-24T13:10:00.000Z',
        },
        updateError: { code: '23P01' },
      }),
      ...CTX,
    })
    const future = new Date(Date.now() + 5 * 86_400_000).toISOString()
    const result = JSON.parse(
      await executor('reschedule_appointment', { slot_id: `slot:${future}` }),
    )
    expect(result).toEqual({ error: 'conflict' })
  })
})

describe('createAgendaToolExecutor', () => {
  it('returns an error result for an unknown tool name instead of throwing', async () => {
    const executor = createAgendaToolExecutor({ db: fakeDb({}), ...CTX })
    const result = JSON.parse(await executor('delete_everything', {}))
    expect(result).toEqual({ error: 'unknown_tool:delete_everything' })
  })
})
