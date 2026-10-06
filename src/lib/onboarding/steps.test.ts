import { describe, expect, it } from 'vitest';
import {
  STEPS,
  isStepComplete,
  markStepDone,
  markStepSkipped,
  nextStep,
  skipAllRemaining,
} from './steps';

describe('nextStep', () => {
  it('returns the first step for a fresh account', () => {
    expect(nextStep({})?.segment).toBe(STEPS[0].segment);
  });

  it('returns the first incomplete step, skipping done/skipped ones', () => {
    let state = markStepDone({}, 'welcome');
    state = markStepDone(state, 'profile');
    state = markStepDone(state, 'profile');
    state = markStepSkipped(state, 'channel');
    expect(nextStep(state)?.segment).toBe('ai-agent');
  });

  it('returns null once every step is done or skipped', () => {
    let state = {};
    for (const step of STEPS) state = markStepDone(state, step.segment);
    expect(nextStep(state)).toBeNull();
  });
});

describe('markStepDone', () => {
  it('marks done and clears skipped, preserving other step data', () => {
    const state = markStepDone({ channel: { skipped: true } }, 'channel', {
      provider: 'waha',
    });
    expect(state.channel).toEqual({
      skipped: false,
      done: true,
      provider: 'waha',
    });
  });

  it('does not touch other steps', () => {
    const state = markStepDone({ welcome: { done: true } }, 'channel');
    expect(state.welcome).toEqual({ done: true });
  });
});

describe('markStepSkipped', () => {
  it('marks skipped without setting done', () => {
    const state = markStepSkipped({}, 'team');
    expect(isStepComplete(state, 'team')).toBe(true);
    expect(state.team.done).toBeUndefined();
  });
});

describe('skipAllRemaining', () => {
  it('skips every incomplete step and leaves completed ones untouched', () => {
    const initial = markStepDone({}, 'welcome');
    const result = skipAllRemaining(initial);

    expect(result.welcome).toEqual({ done: true, skipped: false });
    for (const step of STEPS.slice(1)) {
      expect(isStepComplete(result, step.segment)).toBe(true);
    }
  });

  it('is a no-op when every step is already complete', () => {
    let state: Record<string, { done?: boolean; skipped?: boolean }> = {};
    for (const step of STEPS) state = markStepDone(state, step.segment);
    const result = skipAllRemaining(state);
    expect(result).toEqual(state);
  });
});
