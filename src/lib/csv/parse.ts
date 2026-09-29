/**
 * One CSV reader for the files people actually have
 * (specs/prospecting-csv-import.md §1). Pure — runs in the browser for the
 * preview and on the server for the import, so both see the same rows.
 *
 *  - RFC 4180: quoted cells, `""` escapes, line breaks inside quotes.
 *  - Delimiter detected from the header line: `,` `;` or tab. Excel in
 *    Portuguese saves with `;`, which used to collapse the whole header
 *    into one column.
 *  - Bytes decoded as UTF-8, falling back to Windows-1252 (Excel's
 *    default "CSV" export), so "João" doesn't arrive as "Jo�o".
 */

export const CSV_MAX_BYTES = 5 * 1024 * 1024
export const CSV_MAX_ROWS = 5000

export function decodeCsv(bytes: Uint8Array): string {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    text = new TextDecoder('windows-1252').decode(bytes)
  }
  return text.replace(/^﻿/, '')
}

export function detectDelimiter(text: string): ',' | ';' | '\t' {
  // Header line only, ignoring anything inside quotes.
  let line = ''
  let quoted = false
  for (const ch of text) {
    if (ch === '"') quoted = !quoted
    else if (!quoted && (ch === '\n' || ch === '\r')) break
    else if (!quoted) line += ch
  }
  const count = (d: string) => line.split(d).length - 1
  const candidates: [',' | ';' | '\t', number][] = [
    [';', count(';')],
    ['\t', count('\t')],
    [',', count(',')],
  ]
  candidates.sort((a, b) => b[1] - a[1])
  return candidates[0][1] > 0 ? candidates[0][0] : ','
}

/** Rows of cells. Blank lines are dropped. */
export function parseCsv(text: string, delimiter = detectDelimiter(text)): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false

  const endRow = () => {
    row.push(cell)
    cell = ''
    if (row.some((c) => c.trim() !== '')) rows.push(row)
    row = []
  }

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"'
          i++
        } else {
          quoted = false
        }
      } else {
        cell += ch
      }
      continue
    }
    if (ch === '"' && cell === '') quoted = true
    else if (ch === delimiter) {
      row.push(cell)
      cell = ''
    } else if (ch === '\n') endRow()
    else if (ch === '\r') {
      if (text[i + 1] === '\n') i++
      endRow()
    } else cell += ch
  }
  if (cell !== '' || row.length > 0) endRow()
  return rows
}

export type ContactColumn = 'phone' | 'name' | 'email' | 'company' | 'tags'

const SYNONYMS: Record<ContactColumn, string[]> = {
  phone: ['telefone', 'celular', 'whatsapp', 'whats', 'fone', 'phone', 'mobile', 'numero', 'número', 'tel', 'telefono', 'teléfono'],
  name: ['nome', 'name', 'nombre', 'contato', 'contact', 'cliente'],
  email: ['email', 'e-mail', 'mail', 'correo'],
  company: ['empresa', 'company', 'negocio', 'negócio', 'razao social', 'razão social', 'loja'],
  tags: ['tags', 'tag', 'etiquetas', 'etiqueta', 'marcadores'],
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[_\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/** Header cells → which known column each one is (first match wins). */
export function mapHeaders(header: string[]): Partial<Record<ContactColumn, number>> {
  const out: Partial<Record<ContactColumn, number>> = {}
  header.forEach((raw, idx) => {
    const h = norm(raw)
    for (const col of Object.keys(SYNONYMS) as ContactColumn[]) {
      if (out[col] !== undefined) continue
      if (SYNONYMS[col].some((s) => norm(s) === h)) {
        out[col] = idx
        return
      }
    }
  })
  return out
}
