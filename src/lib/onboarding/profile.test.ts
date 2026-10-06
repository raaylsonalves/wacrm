import { describe, expect, it } from 'vitest';
import { sanitizeProfile, suggestPlan } from './profile';

describe('suggestPlan', () => {
  it('returns null when nothing about size or use was answered', () => {
    expect(suggestPlan({})).toBeNull();
    expect(suggestPlan({ segment: 'beauty', tone: 'friendly' })).toBeNull();
  });

  it('suggests Essencial for a small team with light use', () => {
    expect(
      suggestPlan({ team: '2-3', volume: 'lt20', goals: ['scheduling'] })
    ).toEqual({ plan: 'essencial', reasons: [] });
  });

  it('moves up for team size', () => {
    expect(suggestPlan({ team: '4-8' })).toEqual({
      plan: 'profissional',
      reasons: ['team'],
    });
    expect(suggestPlan({ team: '9-20' })).toEqual({
      plan: 'escala',
      reasons: ['team'],
    });
  });

  it('prospecting and broadcasts need at least Profissional', () => {
    const s = suggestPlan({ team: '1', goals: ['prospecting', 'broadcasts'] });
    expect(s?.plan).toBe('profissional');
    expect(s?.reasons).toEqual(['prospecting', 'broadcasts']);
  });

  it('high volume reaches Escala and keeps only the deciding reason', () => {
    expect(suggestPlan({ team: '4-8', volume: '500+' })).toEqual({
      plan: 'escala',
      reasons: ['volume'],
    });
  });

  it('sends 20+ people to a custom quote', () => {
    expect(suggestPlan({ team: '20+', volume: 'lt20' })?.plan).toBe('custom');
  });
});

describe('sanitizeProfile', () => {
  it('drops unknown values and trims free text', () => {
    expect(
      sanitizeProfile({
        segment: 'nope',
        goals: ['sales', 'hack'],
        team: '2-3',
        about: 'Corte e barba   ',
        hours: 42,
      })
    ).toEqual({
      segment: undefined,
      goals: ['sales'],
      team: '2-3',
      volume: undefined,
      channel: undefined,
      tone: undefined,
      about: 'Corte e barba',
      hours: undefined,
    });
  });

  it('tolerates non-objects', () => {
    expect(sanitizeProfile(null)).toEqual({});
    expect(sanitizeProfile('x')).toEqual({});
  });
});
