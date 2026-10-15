import { describe, expect, it } from 'vitest'
import { agendaStatePrompt, matchByName, slotWindow } from './scale'

describe('slotWindow', () => {
  it('no date = the API default (next days)', () => {
    expect(slotWindow(null, 'morning', null)).toEqual({})
  })
  it('a time asked about gets ±90 min', () => {
    expect(slotWindow('2026-10-16', null, '14:00')).toEqual({ from: '2026-10-16T12:30', to: '2026-10-16T15:30' })
    expect(slotWindow('2026-10-16', null, '00:30')).toEqual({ from: '2026-10-16T00:00', to: '2026-10-16T02:00' })
  })
  it('periods split at noon', () => {
    expect(slotWindow('2026-10-16', 'afternoon', null)).toEqual({ from: '2026-10-16T12:00', to: '2026-10-16T23:59' })
  })
})

describe('agendaStatePrompt', () => {
  it('hands the settled choices back', () => {
    expect(agendaStatePrompt(null)).toBeNull()
    expect(agendaStatePrompt({ unit_id: 'u', unit_name: 'Aldeota', service_ids: ['s'], service_names: ['Corte'] })).toContain('Aldeota')
  })
})

describe('matchByName', () => {
  const services = [
    { id: '1', nome: 'Corte + Barba Aldeota' },
    { id: '2', nome: 'Corte Aldeota' },
    { id: '3', nome: 'Ítalo' },
  ]
  it('picks the closest name, ignoring accents and case', () => {
    expect(matchByName(services, 'corte')?.id).toBe('2')
    expect(matchByName(services, 'corte + barba')?.id).toBe('1')
    expect(matchByName(services, 'italo')?.id).toBe('3')
  })
})
