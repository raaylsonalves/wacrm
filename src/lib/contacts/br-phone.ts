/**
 * Phone cleanup for imported lists (specs/prospecting-csv-import.md §1).
 * Brazilian numbers get special care, since that is where these lists come
 * from; anything already carrying another country code passes through.
 * Pure.
 *
 *  - Masks stripped: "(11) 98765-4321" → digits.
 *  - DDI 55 added to a bare 10/11-digit national number.
 *  - A 10-digit number whose first digit after the DDD is 6–9 is a mobile
 *    in the pre-2016 8-digit form: the ninth digit is inserted.
 *  - A 10-digit number starting 2–5 after the DDD is a LANDLINE: WhatsApp
 *    can't reach it, and trying costs sending reputation — skipped with a
 *    reason instead.
 */

export type PhoneResult =
  | { ok: true; phone: string }
  | { ok: false; reason: 'invalid_phone' | 'landline' }

export function normalizeImportPhone(raw: string): PhoneResult {
  const trimmed = (raw ?? '').trim()
  if (!trimmed) return { ok: false, reason: 'invalid_phone' }
  const hadPlus = trimmed.startsWith('+')
  let d = trimmed.replace(/\D/g, '')
  // "0 11 9…" trunk prefix / "00 55…" international prefix.
  if (d.startsWith('00')) d = d.slice(2)
  else if (!hadPlus && d.length === 12 && d.startsWith('0')) d = d.slice(1)
  else if (!hadPlus && d.length === 11 && d.startsWith('0')) d = d.slice(1)

  // Bare Brazilian national number → add DDI.
  if (!hadPlus && (d.length === 10 || d.length === 11) && !d.startsWith('55')) d = `55${d}`
  // A 12/13-digit number starting 55 is Brazilian. (A foreign number with
  // its own code is accepted as-is below.)
  if (d.startsWith('55') && (d.length === 12 || d.length === 13)) {
    const ddd = d.slice(2, 4)
    const local = d.slice(4)
    if (!/^[1-9][1-9]$/.test(ddd)) return { ok: false, reason: 'invalid_phone' }
    if (local.length === 8) {
      if (/^[2-5]/.test(local)) return { ok: false, reason: 'landline' }
      return { ok: true, phone: `55${ddd}9${local}` }
    }
    if (local.length === 9) {
      if (!local.startsWith('9')) return { ok: false, reason: 'invalid_phone' }
      return { ok: true, phone: d }
    }
  }
  if (d.startsWith('55')) return { ok: false, reason: 'invalid_phone' }
  // Other countries: plausible E.164 length.
  if (d.length >= 8 && d.length <= 15) return { ok: true, phone: d }
  return { ok: false, reason: 'invalid_phone' }
}
