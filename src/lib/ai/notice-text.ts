import { hashKey } from '@/lib/variant'

/**
 * Canned customer-facing wording from a top-level namespace in
 * messages/<locale>.json — `{ <group>: { v1, v2, … } }`. Same rule as the
 * handoff notice: the variant is stable per conversation (a retry can't
 * flip-flop) and a missing translation yields null, so a raw key never
 * reaches a customer. Pure.
 */
export function pickNotice(node: unknown, group: string, leadKey: string): string | null {
  if (!node || typeof node !== 'object') return null
  const g = (node as Record<string, unknown>)[group]
  if (!g || typeof g !== 'object') return null
  const pool = Object.entries(g as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, v]) => v)
    .filter((v): v is string => typeof v === 'string' && v.trim() !== '')
  if (pool.length === 0) return null
  return pool[hashKey(leadKey) % pool.length]
}

export async function loadNoticeText(
  namespace: string,
  group: string,
  leadKey: string,
  locale: string = process.env.NEXT_PUBLIC_APP_LOCALE || 'en',
): Promise<string | null> {
  try {
    const messages = (await import(`../../../messages/${locale}.json`)).default
    return pickNotice(messages?.[namespace], group, leadKey)
  } catch {
    return null
  }
}
