import { describe, expect, it } from 'vitest';
import {
  STEPS,
  isStepComplete,
  markStepDone,
  markStepSkipped,
  nextStep,
  reachableSegments,
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
    expect(nextStep(state)?.segment).toBe('notifications');
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

describe('dependent steps', () => {
  it('skipping the channel skips the AI agent and the test', () => {
    const state = markStepSkipped({}, 'channel');
    expect(isStepComplete(state, 'ai-agent')).toBe(true);
    expect(isStepComplete(state, 'test')).toBe(true);
    expect(state['ai-agent'].skippedBy).toBe('channel');
  });

  it('completing the channel later re-opens them', () => {
    let state = markStepSkipped({}, 'channel');
    state = markStepDone(state, 'channel');
    expect(isStepComplete(state, 'ai-agent')).toBe(false);
    expect(isStepComplete(state, 'test')).toBe(false);
  });

  it('keeps a step the user finished on their own', () => {
    let state = markStepDone({}, 'ai-agent');
    state = markStepSkipped(state, 'channel');
    expect(state['ai-agent'].done).toBe(true);
  });

  it('nextStep ignores steps blocked by a skipped prerequisite', () => {
    // Legacy state: channel skipped, dependents never marked.
    let state = markStepDone({}, 'welcome');
    state = markStepDone(state, 'profile');
    state = { ...state, channel: { skipped: true } };
    expect(nextStep(state)?.segment).toBe('notifications');
  });
});

describe('reachableSegments', () => {
  it('allows resolved steps and the current one, nothing ahead', () => {
    const state = markStepDone({}, 'welcome');
    expect(reachableSegments(state)).toEqual(['welcome', 'profile']);
  });

  it('opens every step when all are complete', () => {
    let state = {};
    for (const step of STEPS) state = markStepDone(state, step.segment);
    expect(reachableSegments(state)).toHaveLength(STEPS.length);
  });
});
