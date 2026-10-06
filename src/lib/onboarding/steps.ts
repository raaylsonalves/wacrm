/**
 * Post-signup onboarding wizard (specs/signup-onboarding-wizard.md).
 *
 * ONE list drives the router, the progress indicator, and the final
 * summary — the spec's central lesson (ported from deskcomm's
 * `lib/onboarding/passos.ts`): three lists that can drift is worse
 * than one that can't.
 *
 * No `applies(ctx)` predicate yet (unlike the spec's draft interface)
 * — every step applies to every account today, and there is no
 * optional feature whose on/off state would skip a step. Add it back
 * the day a real conditional step exists; guessing its shape now
 * would be designing for a requirement that doesn't exist yet.
 */

export interface OnboardingStep {
  segment: string;
  labelKey: string;
}

export const STEPS: readonly OnboardingStep[] = [
  { segment: 'welcome', labelKey: 'stepWelcome' },
  { segment: 'profile', labelKey: 'stepProfile' },
  { segment: 'channel', labelKey: 'stepChannel' },
  { segment: 'ai-agent', labelKey: 'stepAiAgent' },
  { segment: 'test', labelKey: 'stepTest' },
  { segment: 'notifications', labelKey: 'stepNotifications' },
  { segment: 'team', labelKey: 'stepTeam' },
] as const;

export interface StepState {
  done?: boolean;
  skipped?: boolean;
  [key: string]: unknown;
}

/** `accounts.onboarding_state` — one entry per step, keyed by segment. */
export type OnboardingState = Record<string, StepState>;

export function isStepDone(state: OnboardingState, segment: string): boolean {
  return Boolean(state[segment]?.done);
}

export function isStepSkipped(
  state: OnboardingState,
  segment: string
): boolean {
  return Boolean(state[segment]?.skipped);
}

/** Done OR skipped — either way, the router doesn't stop here again. */
export function isStepComplete(
  state: OnboardingState,
  segment: string
): boolean {
  return isStepDone(state, segment) || isStepSkipped(state, segment);
}

/** The first step that isn't done or skipped, or `null` once every
 *  step has been resolved one way or another — the wizard's router
 *  (`/onboarding/page.tsx`) redirects to `/onboarding/done` on `null`. */
export function nextStep(state: OnboardingState): OnboardingStep | null {
  return STEPS.find((s) => !isStepComplete(state, s.segment)) ?? null;
}

/** New state with `segment` marked done — merges rather than replaces
 *  so a step that stores its own data (e.g. `{ provider: 'openai' }`)
 *  doesn't get clobbered by a later done-marking of the same step. */
export function markStepDone(
  state: OnboardingState,
  segment: string,
  extra: Record<string, unknown> = {}
): OnboardingState {
  return {
    ...state,
    [segment]: { ...state[segment], ...extra, done: true, skipped: false },
  };
}

export function markStepSkipped(
  state: OnboardingState,
  segment: string
): OnboardingState {
  return { ...state, [segment]: { ...state[segment], skipped: true } };
}

/** Every incomplete step marked skipped in one go — backs the
 *  always-visible "skip onboarding entirely" link, distinct from
 *  skipping one step at a time. */
export function skipAllRemaining(state: OnboardingState): OnboardingState {
  const next: OnboardingState = { ...state };
  for (const step of STEPS) {
    if (!isStepComplete(next, step.segment)) {
      next[step.segment] = { ...next[step.segment], skipped: true };
    }
  }
  return next;
}
