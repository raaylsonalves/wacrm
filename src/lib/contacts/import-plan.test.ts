import { describe, it, expect } from 'vitest'
import { decodeCsv, detectDelimiter, mapHeaders, parseCsv } from '@/lib/csv/parse'
import { normalizeImportPhone } from './br-phone'
import { mergeConsentBasis, nicheCounts, planImport, updateFor } from './import-plan'

describe('parseCsv', () => {
  it('handles the Brazilian Excel file: ; delimiter, quotes, line break in a cell', () => {
    const text = 'Nome;Telefone;Empresa\r\n"Silva; João";(11) 98765-4321;"Loja\nCentro"\r\n'
    expect(detectDelimiter(text)).toBe(';')
    expect(parseCsv(text)).toEqual([
      ['Nome', 'Telefone', 'Empresa'],
      ['Silva; João', '(11) 98765-4321', 'Loja\nCentro'],
    ])
  })
  it('unescapes doubled quotes and drops blank lines', () => {
    expect(parseCsv('a,b\n\n"x ""y""",z\n')).toEqual([['a', 'b'], ['x "y"', 'z']])
  })
  it('decodes Latin-1 when the bytes are not UTF-8', () => {
    const latin1 = new Uint8Array([0x4a, 0x6f, 0xe3, 0x6f]) // "João" in Windows-1252
    expect(decodeCsv(latin1)).toBe('João')
    expect(decodeCsv(new TextEncoder().encode('﻿João'))).toBe('João')
  })
  it('maps pt/en/es headers, ignoring accents and case', () => {
    expect(mapHeaders(['Nome', 'Celular', 'E-mail', 'Razão Social', 'Cidade'])).toEqual({
      name: 0,
      phone: 1,
      email: 2,
      company: 3,
    })
  })
})

describe('normalizeImportPhone', () => {
  it.each([
    ['(11) 98765-4321', '5511987654321'],
    ['+55 11 98765-4321', '5511987654321'],
    ['011 98765-4321', '5511987654321'],
    ['11 8765-4321', '5511987654321'], // old 8-digit mobile gains the 9
    ['+1 415 555 0100', '14155550100'],
  ])('%s → %s', (raw, want) => expect(normalizeImportPhone(raw)).toEqual({ ok: true, phone: want }))

  it('flags a landline instead of importing it', () => {
    expect(normalizeImportPhone('(11) 3456-7890')).toEqual({ ok: false, reason: 'landline' })
  })
  it.each(['', 'abc', '123', '55 00 98765-4321'])('invalid: %j', (raw) =>
    expect(normalizeImportPhone(raw)).toMatchObject({ ok: false, reason: 'invalid_phone' }),
  )
})

describe('planImport', () => {
  it('plans every row, skipping bad ones with a reason and the line number', () => {
    const plan = planImport([
      ['Nome', 'WhatsApp', 'Email', 'Tags', 'Cidade'],
      ['Ana', '11987654321', 'ana@x.com', 'vip, sp', 'SP'],
      ['Bia', '(11) 3456-7890', '', '', ''],
      ['Ana de novo', '+55 11 98765-4321', '', '', ''],
      ['Caio', '21 99999-0000', 'nao-e-email', '', ''],
      ['', 'lixo', '', '', ''],
    ])
    expect(plan.rows).toHaveLength(1)
    expect(plan.rows[0]).toMatchObject({ line: 2, phone: '5511987654321', tags: ['vip', 'sp'] })
    expect(plan.skipped.map((s) => [s.line, s.reason])).toEqual([
      [3, 'landline'],
      [4, 'duplicate_in_file'],
      [5, 'bad_email'],
      [6, 'invalid_phone'],
    ])
    expect(plan.ignoredColumns).toEqual(['Cidade'])
  })
})

describe('planImport — Google Maps export', () => {
  const header = ['Name', 'Fulladdress', 'Categories', 'Phone', 'Review Count', 'Average Rating', 'Google Maps URL', 'Email']
  it('reads Name as the business and the first category as the niche', () => {
    const plan = planImport([
      header,
      ['Ricardo Veiculos', 'Av. X', 'Revendedora de carros usados,Concessionária', '(85) 99981-1979', '189', '3.8', 'https://maps', 'exportProcessing'],
      ['Viasul Jeep', 'Av. Y', 'Concessionária Jeep', '(85) 3512-0097', '531', '4.5', 'https://maps', ''],
      ['Moto Z', 'Av. Z', 'Revendedora de carros usados', '85 98888-7777', '', '', '', ''],
    ])
    expect(plan.businessList).toBe(true)
    expect(plan.rows[0]).toMatchObject({
      name: null,
      company: 'Ricardo Veiculos',
      email: null,
      niche: 'Revendedora de carros usados',
    })
    expect(plan.skipped.map((s) => s.reason)).toEqual(['landline'])
    expect(nicheCounts(plan.rows)).toEqual([['Revendedora de carros usados', 2]])
  })
  it('a plain list keeps Name as the person', () => {
    const plan = planImport([['Nome', 'Celular', 'Nicho'], ['Ana', '11987654321', 'Padaria']])
    expect(plan.businessList).toBe(false)
    expect(plan.rows[0]).toMatchObject({ name: 'Ana', company: null, niche: 'Padaria' })
  })
})

describe('consent + update policy', () => {
  it('a basis is only ever upgraded', () => {
    expect(mergeConsentBasis(null, 'unknown')).toBe('unknown')
    expect(mergeConsentBasis('unknown', 'opt_in')).toBe('opt_in')
    expect(mergeConsentBasis('opt_in', 'third_party_list')).toBe('opt_in')
  })
  it('fill_empty never overwrites, overwrite does, skip touches nothing', () => {
    const row = { line: 2, phone: '1', name: 'Novo', email: 'n@x.com', company: null, tags: [], niche: null }
    expect(updateFor('fill_empty', { name: 'Antigo', email: null }, row)).toEqual({ email: 'n@x.com' })
    expect(updateFor('overwrite', { name: 'Antigo' }, row)).toEqual({ name: 'Novo', email: 'n@x.com' })
    expect(updateFor('skip', {}, row)).toBeNull()
  })
})
