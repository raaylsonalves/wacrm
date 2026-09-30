import { describe, it, expect } from 'vitest';
import { renderNotification, type Translate } from './render';
import { slaBreachMinutes, formatTimeIn } from './sweeps';

// Echoes the key and its values, so the tests assert which sentence was
// chosen and with what — not the translations themselves.
const t: Translate = (key, values) =>
  values ? `${key} ${JSON.stringify(values)}` : key;

describe('renderNotification — assignment says who and why', () => {
  it('a teammate', () => {
    const r = renderNotification(
      {
        type: 'conversation_assigned',
        actor_name: 'Carla',
        contact_name: 'Ana',
        data: { actor_kind: 'human', last_message: 'Oi, tudo bem?' },
      },
      t
    );
    expect(r.title).toBe('assigned.byPerson {"actor":"Carla","contact":"Ana"}');
    expect(r.body).toBe('Oi, tudo bem?');
  });

  it("a teammate's transfer note wins over the last message", () => {
    const r = renderNotification(
      {
        type: 'conversation_assigned',
        actor_name: 'Carla',
        contact_name: 'Ana',
        data: {
          actor_kind: 'human',
          last_message: 'Oi',
          note: 'Quer desconto no anual, já aprovei 10%',
        },
      },
      t
    );
    expect(r.body).toBe('Quer desconto no anual, já aprovei 10%');
  });

  it('the AI hand-off carries the reason and summary', () => {
    const r = renderNotification(
      {
        type: 'conversation_assigned',
        contact_name: 'Ana',
        data: {
          actor_kind: 'ai',
          handoff_reason: 'customer_requested_human',
          summary: 'Quer falar do contrato',
        },
      },
      t
    );
    expect(r.title).toBe('assigned.byAi {"contact":"Ana"}');
    expect(r.body).toBe(
      'reasons.customer_requested_human · Quer falar do contrato'
    );
  });

  it('automatic distribution', () => {
    const r = renderNotification(
      {
        type: 'conversation_assigned',
        contact_name: 'Ana',
        data: { actor_kind: 'rule' },
      },
      t
    );
    expect(r.title).toBe('assigned.byRule {"contact":"Ana"}');
  });

  it('re-renders the legacy English sentence', () => {
    const r = renderNotification(
      {
        type: 'conversation_assigned',
        body: 'Someone assigned you a conversation with Ana',
      },
      t
    );
    expect(r.title).toBe(
      'assigned.byPerson {"actor":"someone","contact":"Ana"}'
    );
  });
});

describe('renderNotification — other types', () => {
  it('groups replies', () => {
    expect(
      renderNotification(
        {
          type: 'customer_replied',
          contact_name: 'Ana',
          count: 3,
          body: 'e aí?',
        },
        t
      ).title
    ).toBe('replied.many {"contact":"Ana","count":3}');
    expect(
      renderNotification(
        { type: 'customer_replied', contact_name: 'Ana', count: 1 },
        t
      ).title
    ).toBe('replied.one {"contact":"Ana"}');
  });

  it('deal stage move shows from → to', () => {
    const r = renderNotification(
      {
        type: 'deal_stage_changed',
        data: { deal_title: 'Site', from_stage: 'Lead', to_stage: 'Proposta' },
      },
      t
    );
    expect(r.body).toBe('Lead → Proposta');
  });

  it('template status picks the sentence per status', () => {
    expect(
      renderNotification(
        {
          type: 'template_status',
          data: { template: 'boas_vindas', status: 'REJECTED', reason: 'Spam' },
        },
        t
      )
    ).toEqual({
      title: 'template.rejected {"template":"boas_vindas"}',
      body: 'Spam',
    });
  });

  it('case alerts keep their own text', () => {
    expect(
      renderNotification(
        { type: 'case_opened', title: 'Liberar acesso', body: 'b' },
        t
      )
    ).toEqual({
      title: 'Liberar acesso',
      body: 'b',
    });
  });
});

describe('slaBreachMinutes', () => {
  const now = Date.UTC(2026, 8, 30, 12, 0);
  const ago = (min: number) => new Date(now - min * 60_000).toISOString();

  it('fires past the target, once per customer message', () => {
    expect(
      slaBreachMinutes({
        lastCustomerMessageAt: ago(20),
        notifiedAt: null,
        targetMinutes: 15,
        now,
      })
    ).toBe(20);
    expect(
      slaBreachMinutes({
        lastCustomerMessageAt: ago(10),
        notifiedAt: null,
        targetMinutes: 15,
        now,
      })
    ).toBeNull();
    expect(
      slaBreachMinutes({
        lastCustomerMessageAt: ago(20),
        notifiedAt: ago(1),
        targetMinutes: 15,
        now,
      })
    ).toBeNull();
    // A newer customer message after the last alert re-arms it.
    expect(
      slaBreachMinutes({
        lastCustomerMessageAt: ago(20),
        notifiedAt: ago(60),
        targetMinutes: 15,
        now,
      })
    ).toBe(20);
  });

  it('ignores ancient backlog and disabled targets', () => {
    expect(
      slaBreachMinutes({
        lastCustomerMessageAt: ago(60 * 13),
        notifiedAt: null,
        targetMinutes: 15,
        now,
      })
    ).toBeNull();
    expect(
      slaBreachMinutes({
        lastCustomerMessageAt: ago(20),
        notifiedAt: null,
        targetMinutes: 0,
        now,
      })
    ).toBeNull();
  });
});

describe('formatTimeIn', () => {
  it('formats in the agenda timezone', () => {
    expect(formatTimeIn('2026-09-30T17:30:00Z', 'America/Sao_Paulo')).toBe(
      '14:30'
    );
  });
});
