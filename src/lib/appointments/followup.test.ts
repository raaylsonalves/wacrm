import { describe, it, expect } from 'vitest'
import { followupParams, followupWindow, templateVarCount, FOLLOWUP_GRACE_DAYS } from './followup'

describe('followupWindow', () => {
  it('is due from `days` ago back to the grace limit', () => {
    const now = new Date('2026-10-10T12:00:00Z')
    const { from, to } = followupWindow(now, 3)
    expect(to.toISOString()).toBe('2026-10-07T12:00:00.000Z')
    expect((to.getTime() - from.getTime()) / 86_400_000).toBe(FOLLOWUP_GRACE_DAYS)
  })
})

describe('followupParams', () => {
  it('fills {{1}} with the first name', () => {
    expect(followupParams('Oi {{1}}, como ficou o corte?', 'Raylson Alves')).toEqual(['Raylson'])
  })
  it('sends no params for a template without variables', () => {
    expect(followupParams('Como ficou o corte?', 'Ana')).toEqual([])
  })
  it('falls back when the contact has no name', () => {
    expect(followupParams('Oi {{1}}', null)).toEqual(['cliente'])
  })
  it('counts distinct placeholders', () => {
    expect(templateVarCount('{{1}} e {{2}} e {{1}}')).toBe(2)
  })
})
