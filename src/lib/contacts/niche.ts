/**
 * Niche tags: an imported prospecting list can be split by business
 * segment ("Categories" in a Google Maps export). Each contact gets one
 * `nicho:<segment>` tag, which the campaign funnel groups by. Pure.
 */

export const NICHE_PREFIX = 'nicho:'

export function nicheTag(niche: string): string {
  return `${NICHE_PREFIX}${niche.trim()}`.slice(0, 60)
}

/** The niche a contact's tags name, if any. */
export function nicheOf(tagNames: string[]): string | null {
  const tag = tagNames.find((n) => n.startsWith(NICHE_PREFIX))
  return tag ? tag.slice(NICHE_PREFIX.length) || null : null
}
