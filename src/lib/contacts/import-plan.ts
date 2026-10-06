/**
 * Turn parsed CSV rows into a per-row plan (specs/prospecting-csv-import.md
 * §2). Pure: no database. Every row either becomes a contact candidate or
 * is skipped with a nominal reason — never all-or-nothing.
 */
import { mapHeaders } from '@/lib/csv/parse'
import { normalizeImportPhone } from './br-phone'

export const CONSENT_BASES = [
  'opt_in',
  'existing_customer',
  'legitimate_interest',
  'third_party_list',
  'unknown',
] as const
export type ConsentBasis = (typeof CONSENT_BASES)[number]

export const UPDATE_POLICIES = ['skip', 'fill_empty', 'overwrite'] as const
export type UpdatePolicy = (typeof UPDATE_POLICIES)[number]

export type SkipReason =
  | 'invalid_phone'
  | 'landline'
  | 'duplicate_in_file'
  | 'bad_email'
  | 'opted_out'
  | 'exists'
  | 'failed'
  | 'other_niche'

export interface PlannedRow {
  /** 1-based line in the file, header = line 1. */
  line: number
  phone: string
  name: string | null
  email: string | null
  company: string | null
  tags: string[]
  /** Business segment, for splitting a prospecting list (first category). */
  niche: string | null
}

export interface ImportPlan {
  rows: PlannedRow[]
  skipped: { line: number; reason: SkipReason; raw: string }[]
  /** Which known columns were found (for the preview). */
  columns: string[]
  /** Header cells that matched nothing — ignored in v1. */
  ignoredColumns: string[]
  /** A Google Maps export: its "Name" is the business, not a person. */
  businessList: boolean
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** Columns only a Google Maps scrape has. */
const MAPS_SIGNATURE = ['google maps url', 'place id', 'review count', 'average rating', 'plus code']

/** Rows per niche, largest first. Rows without one are counted under ''. */
export function nicheCounts(rows: Pick<PlannedRow, 'niche'>[]): [string, number][] {
  const m = new Map<string, number>()
  for (const r of rows) m.set(r.niche ?? '', (m.get(r.niche ?? '') ?? 0) + 1)
  return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
}

/** Rank used to only ever UPGRADE a contact's basis on a later import. */
const BASIS_RANK: Record<ConsentBasis, number> = {
  third_party_list: 0,
  unknown: 1,
  legitimate_interest: 2,
  existing_customer: 3,
  opt_in: 4,
}

/** The basis a contact should end with: null (existing contacts, untouched
 *  until an import) takes the new one; otherwise the stronger wins. */
export function mergeConsentBasis(
  current: string | null | undefined,
  incoming: ConsentBasis,
): ConsentBasis {
  if (!current || !(current in BASIS_RANK)) return incoming
  const cur = current as ConsentBasis
  return BASIS_RANK[incoming] > BASIS_RANK[cur] ? incoming : cur
}

export function planImport(table: string[][]): ImportPlan {
  const [header = [], ...body] = table
  const map = mapHeaders(header)
  const columns = Object.keys(map)
  const known = new Set(Object.values(map))
  const ignoredColumns = header.filter((h, i) => !known.has(i) && h.trim() !== '')
  const lower = header.map((h) => h.trim().toLowerCase())
  const businessList =
    map.company === undefined && MAPS_SIGNATURE.filter((c) => lower.includes(c)).length >= 2

  const plan: ImportPlan = { rows: [], skipped: [], columns, ignoredColumns, businessList }
  const seen = new Set<string>()
  const cell = (r: string[], i: number | undefined) =>
    i === undefined ? '' : (r[i] ?? '').trim()

  body.forEach((r, idx) => {
    const line = idx + 2
    const raw = r.join(' | ').slice(0, 200)
    const phone = normalizeImportPhone(cell(r, map.phone))
    if (!phone.ok) {
      plan.skipped.push({ line, reason: phone.reason, raw })
      return
    }
    if (seen.has(phone.phone)) {
      plan.skipped.push({ line, reason: 'duplicate_in_file', raw })
      return
    }
    // Scrapers fill unfinished cells with placeholders ("exportProcessing"):
    // on a business list a bad email is dropped, never the business.
    const rawEmail = cell(r, map.email)
    const email = businessList && !EMAIL.test(rawEmail) ? '' : rawEmail
    if (email && !EMAIL.test(email)) {
      plan.skipped.push({ line, reason: 'bad_email', raw })
      return
    }
    seen.add(phone.phone)
    const named = cell(r, map.name) || null
    plan.rows.push({
      line,
      phone: phone.phone,
      name: businessList ? null : named,
      email: email || null,
      company: businessList ? named : cell(r, map.company) || null,
      niche: cell(r, map.niche).split(',')[0].trim().slice(0, 60) || null,
      tags: cell(r, map.tags)
        .split(/[,;|]/)
        .map((t) => t.trim())
        .filter(Boolean),
    })
  })
  return plan
}

/** Fields to write on an EXISTING contact under a policy; null = leave it. */
export function updateFor(
  policy: UpdatePolicy,
  existing: { name?: string | null; email?: string | null; company?: string | null },
  row: PlannedRow,
): Record<string, string> | null {
  if (policy === 'skip') return null
  const out: Record<string, string> = {}
  for (const key of ['name', 'email', 'company'] as const) {
    const incoming = row[key]
    if (!incoming) continue
    if (policy === 'overwrite' || !existing[key]) out[key] = incoming
  }
  return out
}
