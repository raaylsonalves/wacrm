// The optional "about your business" answers collected in onboarding.
// They do two things: seed the AI assistant's business context and suggest
// a plan. Every field is optional — a half-filled profile is still useful.

import { PLAN_IDS, PLAN_USERS, type PlanId } from '@/lib/billing/plans';

export const SEGMENTS = [
  'beauty',
  'health',
  'retail',
  'services',
  'education',
  'finance',
  'realestate',
  'other',
] as const;
export const GOALS = [
  'support',
  'scheduling',
  'sales',
  'prospecting',
  'broadcasts',
  'loans',
] as const;
export const TEAM_SIZES = ['1', '2-3', '4-8', '9-20', '20+'] as const;
export const VOLUMES = ['lt20', '20-100', '100-500', '500+'] as const;
export const TONES = ['friendly', 'formal', 'direct'] as const;
export const CHANNELS = ['official', 'regular', 'none'] as const;

export type Segment = (typeof SEGMENTS)[number];
export type Goal = (typeof GOALS)[number];
export type TeamSize = (typeof TEAM_SIZES)[number];
export type Volume = (typeof VOLUMES)[number];
export type Tone = (typeof TONES)[number];
export type ChannelKind = (typeof CHANNELS)[number];

export interface BusinessProfile {
  segment?: Segment;
  goals?: Goal[];
  team?: TeamSize;
  volume?: Volume;
  channel?: ChannelKind;
  tone?: Tone;
  /** Free text: what they sell, prices, differentiators. */
  about?: string;
  /** Opening hours, same shape the agenda stores (0 = Sunday). */
  workDays?: number[];
  dayStart?: string;
  dayEnd?: string;
}

export type PlanReason = 'team' | 'volume' | 'prospecting' | 'broadcasts';

export interface PlanSuggestion {
  /** `custom` = beyond the largest plan (20+ people): talk to Nordia. */
  plan: PlanId | 'custom';
  reasons: PlanReason[];
}

const TEAM_MAX: Record<TeamSize, number> = {
  '1': 1,
  '2-3': 3,
  '4-8': 8,
  '9-20': 20,
  '20+': 21,
};

/**
 * The smallest plan that fits what they told us, with the reasons that
 * pushed it up. Returns null when no sizing question was answered — a
 * suggestion made from nothing would be a guess dressed up as advice.
 */
export function suggestPlan(p: BusinessProfile): PlanSuggestion | null {
  const goals = p.goals ?? [];
  if (!p.team && !p.volume && goals.length === 0) return null;

  let rank = 0;
  const reasons: PlanReason[] = [];
  const raise = (to: number, reason: PlanReason) => {
    if (to > rank) {
      rank = to;
      reasons.length = 0;
    }
    if (to === rank && !reasons.includes(reason)) reasons.push(reason);
  };

  if (p.team) {
    const max = TEAM_MAX[p.team];
    if (max > PLAN_USERS.escala) return { plan: 'custom', reasons: ['team'] };
    const fit = PLAN_IDS.findIndex((id) => max <= PLAN_USERS[id]);
    if (fit > 0) raise(fit, 'team');
  }
  if (p.volume === '100-500') raise(1, 'volume');
  if (p.volume === '500+') raise(2, 'volume');
  if (goals.includes('prospecting')) raise(1, 'prospecting');
  if (goals.includes('broadcasts')) raise(1, 'broadcasts');

  return { plan: PLAN_IDS[rank], reasons };
}

/** Keep only well-formed answers from stored jsonb, so a stale or edited
 *  state can never feed unexpected values into the UI or the prompt. */
export function sanitizeProfile(raw: unknown): BusinessProfile {
  if (!raw || typeof raw !== 'object') return {};
  const r = raw as Record<string, unknown>;
  const pick = <T extends string>(list: readonly T[], v: unknown) =>
    list.includes(v as T) ? (v as T) : undefined;
  const text = (v: unknown, max: number) =>
    typeof v === 'string'
      ? v.replace(/\s+$/g, '').slice(0, max) || undefined
      : undefined;
  const goals = Array.isArray(r.goals)
    ? GOALS.filter((g) => (r.goals as unknown[]).includes(g))
    : undefined;
  const days = Array.isArray(r.workDays)
    ? [0, 1, 2, 3, 4, 5, 6].filter((d) => (r.workDays as unknown[]).includes(d))
    : undefined;
  const clock = (v: unknown, allowEnd: boolean) =>
    typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v)
      ? v
      : allowEnd && v === '24:00'
        ? v
        : undefined;
  return {
    segment: pick(SEGMENTS, r.segment),
    goals: goals?.length ? [...goals] : undefined,
    team: pick(TEAM_SIZES, r.team),
    volume: pick(VOLUMES, r.volume),
    channel: pick(CHANNELS, r.channel),
    tone: pick(TONES, r.tone),
    about: text(r.about, 600),
    workDays: days?.length ? days : undefined,
    dayStart: days?.length ? clock(r.dayStart, false) : undefined,
    dayEnd: days?.length ? clock(r.dayEnd, true) : undefined,
  };
}

export interface PromptTexts {
  business: (name: string) => string;
  segment: (label: string) => string;
  goals: (labels: string) => string;
  tone: (label: string) => string;
  about: (text: string) => string;
  hours: (text: string) => string;
  allDay: () => string;
  dayLabel: (d: number) => string;
  segmentLabel: (s: Segment) => string;
  goalLabel: (g: Goal) => string;
  toneLabel: (t: Tone) => string;
}

/**
 * The business context the AI assistant starts from, one fact per line.
 * Only what was actually answered appears — empty answers add no noise,
 * and the owner can edit the text freely afterwards.
 */
export function buildPromptContext(
  p: BusinessProfile,
  businessName: string,
  x: PromptTexts
): string {
  const lines: string[] = [];
  if (businessName.trim()) lines.push(x.business(businessName.trim()));
  if (p.segment) lines.push(x.segment(x.segmentLabel(p.segment)));
  if (p.goals?.length)
    lines.push(x.goals(p.goals.map((g) => x.goalLabel(g)).join(', ')));
  if (p.tone) lines.push(x.tone(x.toneLabel(p.tone)));
  if (p.about) lines.push(x.about(p.about));
  if (p.workDays?.length && p.dayStart && p.dayEnd) {
    const all =
      p.workDays.length === 7 && p.dayStart === '00:00' && p.dayEnd === '24:00';
    const mon1 = [1, 2, 3, 4, 5, 6, 0].filter((d) => p.workDays?.includes(d));
    lines.push(
      x.hours(
        all
          ? x.allDay()
          : `${mon1.map((d) => x.dayLabel(d)).join(', ')} ${p.dayStart}-${p.dayEnd}`
      )
    );
  }
  return lines.join('\n');
}
