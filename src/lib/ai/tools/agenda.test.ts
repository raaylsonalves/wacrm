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
 *  `loadBusyRanges` / the `book_appointment` insert issue against. */
function fakeDb(opts: {
  settingsRow?: Record<string, unknown> | null
  busyRows?: { starts_at: string; ends_at: string }[]
  insertError?: { code?: string; message?: string } | null
  insertedRows?: Record<string, unknown>[]
}): SupabaseClient {
  const insertedRows = opts.insertedRows ?? []
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
          select: () => ({
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
          }),
          insert: (row: Record<string, unknown>) => {
            insertedRows.push(row)
            return Promise.resolve({ error: opts.insertError ?? null })
          },
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
  it('defines exactly offer_slots and book_appointment', () => {
    expect(AGENDA_TOOLS.map((t) => t.name)).toEqual(['offer_slots', 'book_appointment'])
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

describe('createAgendaToolExecutor', () => {
  it('returns an error result for an unknown tool name instead of throwing', async () => {
    const executor = createAgendaToolExecutor({ db: fakeDb({}), ...CTX })
    const result = JSON.parse(await executor('delete_everything', {}))
    expect(result).toEqual({ error: 'unknown_tool:delete_everything' })
  })
})
