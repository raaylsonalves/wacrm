/**
 * Which approved Meta templates this CRM can actually send. The send path
 * (`buildSendComponents`) knows HEADER (text/image/video/document), BODY
 * variables and URL buttons; the formats below need per-card media, an
 * expiry, a catalog or a location that nothing here supplies, so Meta
 * rejects them with #132012. The sync stores the reason (migration 099)
 * and the pickers keep them out of reach. Pure.
 */
export type UnsupportedReason =
  'carousel' | 'limited_time_offer' | 'catalog' | 'location_header';

interface ComponentLike {
  type?: string;
  format?: string;
  buttons?: { type?: string }[];
}

export function unsupportedTemplateReason(
  components: ComponentLike[] | null | undefined
): UnsupportedReason | null {
  for (const c of components ?? []) {
    const type = (c.type ?? '').toUpperCase();
    if (type === 'CAROUSEL') return 'carousel';
    if (type === 'LIMITED_TIME_OFFER') return 'limited_time_offer';
    if (type === 'HEADER' && (c.format ?? '').toUpperCase() === 'LOCATION') {
      return 'location_header';
    }
    if (type === 'BUTTONS') {
      for (const b of c.buttons ?? []) {
        const bt = (b.type ?? '').toUpperCase();
        if (bt === 'CATALOG' || bt === 'MPM' || bt === 'SPM') return 'catalog';
      }
    }
  }
  return null;
}
