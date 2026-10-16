/**
 * Segment profiles (migration 135, specs/painel-gestor.md phase 3).
 *
 * One CRM, different businesses: a barbershop lives on its agenda and
 * barely uses deals; a credit broker calls them proposals and loses them
 * when the bank says no. A profile only changes words, defaults and what
 * is shown first — never what is possible. Stage names live in
 * messages/*.json (`Segments.stages.<segment>`) so they follow the locale.
 */
import { SEGMENTS, type Segment } from '@/lib/onboarding/profile';
import { LOSS_REASONS, type LossReason } from '@/lib/leads/origin';

export { SEGMENTS, type Segment };

/** What a deal is called: `Segments.term.<term>` / `termOne.<term>`. */
export type DealTerm = 'deal' | 'proposal' | 'sale' | 'enrollment' | 'treatment';

export interface SegmentProfile {
  term: DealTerm;
  /** Dashboard blocks: today's agenda, and money sold. */
  blocks: { agenda: boolean; sales: boolean };
  /** Loss reasons, most likely first for this business. */
  lossOrder: readonly LossReason[];
}

const DEFAULT: SegmentProfile = {
  term: 'deal',
  blocks: { agenda: true, sales: true },
  lossOrder: LOSS_REASONS,
};

export const SEGMENT_PROFILES: Record<Segment, SegmentProfile> = {
  beauty: { term: 'sale', blocks: { agenda: true, sales: false }, lossOrder: ['no_response', 'timing', 'price', 'competitor', 'not_fit', 'other'] },
  health: { term: 'treatment', blocks: { agenda: true, sales: true }, lossOrder: ['price', 'timing', 'no_response', 'not_fit', 'competitor', 'other'] },
  retail: { term: 'sale', blocks: { agenda: false, sales: true }, lossOrder: ['price', 'no_response', 'competitor', 'timing', 'not_fit', 'other'] },
  services: { term: 'proposal', blocks: { agenda: true, sales: true }, lossOrder: ['price', 'competitor', 'timing', 'no_response', 'not_fit', 'other'] },
  education: { term: 'enrollment', blocks: { agenda: true, sales: true }, lossOrder: ['price', 'timing', 'no_response', 'competitor', 'not_fit', 'other'] },
  finance: { term: 'proposal', blocks: { agenda: false, sales: true }, lossOrder: ['not_fit', 'no_response', 'price', 'timing', 'competitor', 'other'] },
  realestate: { term: 'deal', blocks: { agenda: true, sales: true }, lossOrder: ['price', 'timing', 'not_fit', 'no_response', 'competitor', 'other'] },
  other: DEFAULT,
};

export function isSegment(v: unknown): v is Segment {
  return typeof v === 'string' && (SEGMENTS as readonly string[]).includes(v);
}

export function profileFor(segment: string | null | undefined): SegmentProfile {
  return isSegment(segment) ? SEGMENT_PROFILES[segment] : DEFAULT;
}

const STAGE_COLORS = ['#3b82f6', '#eab308', '#f97316', '#8b5cf6', '#22c55e', '#14b8a6', '#ec4899'];

/** Stage rows for a new pipeline, last stage always green ("done"). */
export function stageRows(names: string[]): { name: string; color: string; position: number }[] {
  return names.map((name, position) => ({
    name,
    position,
    color: position === names.length - 1 ? '#22c55e' : STAGE_COLORS[position % (STAGE_COLORS.length - 3)],
  }));
}
