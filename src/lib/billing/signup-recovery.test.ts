import { describe, expect, it } from 'vitest';
import { recoveryStageFor } from './signup-recovery';
import { buildBillingEmail } from '@/lib/email/billing';
import { billingTemplateFor } from './whatsapp-notify';

const now = new Date('2026-10-11T12:00:00Z');
const ago = (ms: number) => new Date(now.getTime() - ms);
const H = 3_600_000;

describe('recoveryStageFor', () => {
  it('waits an hour, nudges, nudges again after a day, gives up after a week', () => {
    expect(recoveryStageFor(ago(30 * 60_000), now)).toBeNull();
    expect(recoveryStageFor(ago(H), now)).toBe(1);
    expect(recoveryStageFor(ago(23 * H), now)).toBe(1);
    expect(recoveryStageFor(ago(24 * H), now)).toBe(2);
    expect(recoveryStageFor(ago(8 * 24 * H), now)).toBeNull();
  });
});

describe('signup_incomplete notices', () => {
  it('e-mails a link to choose a plan', () => {
    const m = buildBillingEmail(
      { kind: 'signup_incomplete', stage: 1 },
      'Clínica Sorriso'
    );
    expect(m.subject).toContain('Falta pouco');
    expect(m.text).toContain('/settings?tab=billing');
  });

  it('uses the WhatsApp template only on the first nudge', () => {
    const ctx = { firstName: 'Ana', plan: 'Essencial', accountName: 'X' };
    expect(
      billingTemplateFor({ kind: 'signup_incomplete', stage: 1 }, ctx)
    ).toEqual({
      name: 'nordia_cadastro_incompleto',
      params: ['Ana'],
    });
    expect(
      billingTemplateFor({ kind: 'signup_incomplete', stage: 2 }, ctx)
    ).toBeNull();
  });
});
