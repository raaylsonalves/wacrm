/**
 * Deterministic "get me a person" detection (specs/ai-agents-management.md §4).
 *
 * Handing off used to depend entirely on the model choosing to: a customer
 * typing "quero falar com um atendente" reached it like any other text.
 * An account can now list phrases that hand the conversation to a human
 * BEFORE any model call — no tokens spent, no model discretion.
 *
 * Whole-phrase, accent- and case-insensitive: "atendente" matches
 * "Quero um ATENDENTE, por favor" but not "atendentes-modelo" or the
 * middle of a longer word. Precedent: `isOptOutMessage`. Pure — no I/O.
 */

/** Starter list offered by the "Use suggestions" button, pt / en / es. */
export const SUGGESTED_HANDOFF_KEYWORDS = [
  'atendente',
  'falar com humano',
  'falar com uma pessoa',
  'pessoa real',
  'quero um atendente',
  'human',
  'real person',
  'talk to a person',
  'speak to an agent',
  'agente humano',
  'hablar con una persona',
  'persona real',
] as const

/** Lowercase, strip accents, collapse whitespace/punctuation to single
 *  spaces so "Atendente!!" and "atendente" compare equal. */
export function normalizeForKeyword(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

/** Clean a user-entered list: trimmed, deduped (after normalizing),
 *  blanks dropped, capped so a pasted wall of text can't bloat the row. */
export function cleanHandoffKeywords(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim().slice(0, 80)
    const key = normalizeForKeyword(trimmed)
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(trimmed)
    if (out.length >= 30) break
  }
  return out
}

/** The first configured keyword found in `text` as a whole phrase, or
 *  null. Empty text or an empty list never matches. */
export function matchHandoffKeyword(
  text: string,
  keywords: readonly string[],
): string | null {
  if (!keywords.length) return null
  const haystack = ` ${normalizeForKeyword(text)} `
  if (haystack.trim() === '') return null
  for (const keyword of keywords) {
    const needle = normalizeForKeyword(keyword)
    if (needle && haystack.includes(` ${needle} `)) return keyword
  }
  return null
}
