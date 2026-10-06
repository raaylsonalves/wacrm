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
  /** Needs another step to have been completed (not skipped): the AI
   *  agent and the test reply are pointless without a connected channel,
   *  so skipping the channel skips them too. */
  requires?: string;
}

export const STEPS: readonly OnboardingStep[] = [
  { segment: 'welcome', labelKey: 'stepWelcome' },
  { segment: 'profile', labelKey: 'stepProfile' },
  { segment: 'payment', labelKey: 'stepPayment' },
  { segment: 'channel', labelKey: 'stepChannel' },
  { segment: 'ai-agent', labelKey: 'stepAiAgent', requires: 'channel' },
  { segment: 'test', labelKey: 'stepTest', requires: 'channel' },
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
  return (
    STEPS.find(
      (s) =>
        !isStepComplete(state, s.segment) && !isBlockedByDependency(state, s)
    ) ?? null
  );
}

/** A step whose prerequisite was skipped never needs doing. */
function isBlockedByDependency(
  state: OnboardingState,
  step: OnboardingStep
): boolean {
  return Boolean(step.requires && isStepSkipped(state, step.requires));
}

/** Steps the user may open: everything already resolved, plus the one
 *  they are on. Anything further ahead stays locked until reached. */
export function reachableSegments(state: OnboardingState): string[] {
  const current = nextStep(state)?.segment;
  const out: string[] = [];
  for (const s of STEPS) {
    if (isStepComplete(state, s.segment) || s.segment === current) {
      out.push(s.segment);
    }
  }
  return out;
}

/** New state with `segment` marked done — merges rather than replaces
 *  so a step that stores its own data (e.g. `{ provider: 'openai' }`)
 *  doesn't get clobbered by a later done-marking of the same step. */
export function markStepDone(
  state: OnboardingState,
  segment: string,
  extra: Record<string, unknown> = {}
): OnboardingState {
  const next: OnboardingState = {
    ...state,
    [segment]: { ...state[segment], ...extra, done: true, skipped: false },
  };
  // Completing a prerequisite re-opens the steps its earlier skip closed.
  for (const step of STEPS) {
    if (
      step.requires === segment &&
      state[step.segment]?.skippedBy === segment
    ) {
      next[step.segment] = { skipped: false };
    }
  }
  return next;
}

export function markStepSkipped(
  state: OnboardingState,
  segment: string
): OnboardingState {
  const next: OnboardingState = {
    ...state,
    // Skipping after finishing replaces the answer: done and skipped are
    // mutually exclusive.
    [segment]: { ...state[segment], skipped: true, done: false },
  };
  // Skipping a prerequisite skips what depends on it, remembering why.
  for (const step of STEPS) {
    if (step.requires === segment && !isStepComplete(next, step.segment)) {
      next[step.segment] = { skipped: true, skippedBy: segment };
    }
  }
  return next;
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
