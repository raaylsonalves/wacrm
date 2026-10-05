import { describe, it, expect } from 'vitest';
import {
  conditionHolds,
  interpolateVars,
  simulate,
  type ConditionFacts,
} from './simulate';

const facts = (over: Partial<ConditionFacts> = {}): ConditionFacts => ({
  tagIds: ['vip'],
  contact: { company: 'Navalha' },
  messageText: 'Quero agendar um corte',
  now: new Date(2026, 9, 5, 10, 30),
  ...over,
});

describe('conditionHolds', () => {
  it('tag presence', () => {
    expect(
      conditionHolds({ subject: 'tag_presence', operand: 'vip' }, facts())
    ).toBe(true);
    expect(
      conditionHolds({ subject: 'tag_presence', operand: 'x' }, facts())
    ).toBe(false);
  });

  it('contact field equals', () => {
    expect(
      conditionHolds(
        { subject: 'contact_field', operand: 'company', value: 'Navalha' },
        facts()
      )
    ).toBe(true);
    expect(
      conditionHolds(
        { subject: 'contact_field', operand: 'company', value: 'x' },
        facts()
      )
    ).toBe(false);
  });

  it('message contains, case-insensitive', () => {
    expect(
      conditionHolds({ subject: 'message_content', value: 'AGENDAR' }, facts())
    ).toBe(true);
  });

  it('time of day, including over-midnight windows', () => {
    expect(
      conditionHolds(
        { subject: 'time_of_day', operand: '09:00-18:00' },
        facts()
      )
    ).toBe(true);
    expect(
      conditionHolds(
        { subject: 'time_of_day', operand: '18:00-09:00' },
        facts()
      )
    ).toBe(false);
    expect(
      conditionHolds(
        { subject: 'time_of_day', operand: '18:00-09:00' },
        facts({ now: new Date(2026, 9, 5, 23, 0) })
      )
    ).toBe(true);
  });
});

describe('interpolateVars', () => {
  it('fills message.text and vars, blanks the rest', () => {
    expect(
      interpolateVars('Você disse: {{ message.text }} {{vars.x}}{{nome}}', {
        messageText: 'oi',
        vars: { x: '!' },
      })
    ).toBe('Você disse: oi !');
  });
});

describe('simulate', () => {
  const steps = [
    {
      cid: 'm',
      step_type: 'send_message',
      step_config: { text: 'Recebi: {{message.text}}' },
    },
    {
      cid: 'c',
      step_type: 'condition',
      step_config: { subject: 'tag_presence', operand: 'vip' },
      branches: {
        yes: [{ cid: 'y', step_type: 'add_tag', step_config: {} }],
        no: [{ cid: 'n', step_type: 'wait', step_config: {} }],
      },
    },
    { cid: 'z', step_type: 'close_conversation', step_config: {} },
  ];

  it('follows only the branch the condition takes, then continues', () => {
    const r = simulate(steps, facts());
    expect(r.map((s) => s.cid)).toEqual(['m', 'c', 'y', 'z']);
    expect(r[0].text).toBe('Recebi: Quero agendar um corte');
    expect(r[1].branch).toBe('yes');
    expect(r[2].depth).toBe(1);
  });

  it('takes the No branch when the condition fails', () => {
    const r = simulate(steps, facts({ tagIds: [] }));
    expect(r.map((s) => s.cid)).toEqual(['m', 'c', 'n', 'z']);
  });
});
