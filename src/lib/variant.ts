/**
 * Stable wording variants. Identical bodies sent to many customers are
 * what makes a WhatsApp number look automated, so messages that go out
 * in bulk (handoff notices, follow-ups) carry several phrasings and pick
 * one by hashing a stable key — the same conversation always gets the
 * same wording (no flip-flop on retry), different conversations differ.
 */

/** FNV-1a — stable across runs and platforms, unlike `Math.random`. */
export function hashKey(key: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** The variant for `key`, or null when there are none. Blank entries are
 *  ignored so a half-filled editor row can't send an empty message. */
export function pickVariant(variants: readonly string[], key: string): string | null {
  const usable = variants.filter((v) => typeof v === 'string' && v.trim() !== '')
  if (usable.length === 0) return null
  return usable[hashKey(key) % usable.length]
}
