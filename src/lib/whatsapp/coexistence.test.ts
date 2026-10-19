import { describe, expect, it } from 'vitest';
import {
  appSecretProof,
  hostedSignupUrl,
  matchSignup,
  parseDisconnect,
  parseEchoes,
  parseHistory,
  parsePartnerAdded,
  parseStateSync,
} from './coexistence';

describe('hostedSignupUrl', () => {
  it('asks for the business app flow only in coexistence mode', () => {
    const coex = new URL(
      hostedSignupUrl({ appId: '1', configId: '2', mode: 'coexistence' })
    );
    expect(coex.searchParams.get('app_id')).toBe('1');
    expect(coex.searchParams.get('config_id')).toBe('2');
    expect(JSON.parse(coex.searchParams.get('extras')!)).toEqual({
      sessionInfoVersion: '3',
      version: 'v4',
      featureType: 'whatsapp_business_app_onboarding',
    });
    const api = new URL(
      hostedSignupUrl({ appId: '1', configId: '2', mode: 'api' })
    );
    expect(
      JSON.parse(api.searchParams.get('extras')!).featureType
    ).toBeUndefined();
  });
});

describe('matchSignup', () => {
  const now = Date.parse('2026-10-19T20:00:00Z');
  const ago = (min: number) => new Date(now - min * 60_000).toISOString();

  it('a request that named the number wins, Brazil’s 9th digit included', () => {
    const waiting = [
      { id: 'fresh', phone_digits: null, created_at: ago(1) },
      { id: 'a', phone_digits: '5511988887777', created_at: ago(5) },
      { id: 'b', phone_digits: '558591331364', created_at: ago(5) },
    ];
    expect(matchSignup(waiting, '+55 85 9133-1364', now)?.id).toBe('b');
    expect(matchSignup(waiting, '+55 11 98888-7777', now)?.id).toBe('a');
  });

  it('otherwise the newest unnamed request of the last hour claims it', () => {
    const waiting = [
      { id: 'new', phone_digits: null, created_at: ago(2) },
      { id: 'old', phone_digits: null, created_at: ago(10) },
    ];
    expect(matchSignup(waiting, '+55 85 9133-1364', now)?.id).toBe('new');
    expect(
      matchSignup(
        [{ id: 'stale', phone_digits: null, created_at: ago(90) }],
        '+55 85 9133-1364',
        now
      )
    ).toBeNull();
    expect(
      matchSignup(
        [{ id: 'other', phone_digits: '5511988887777', created_at: ago(1) }],
        '+55 85 9133-1364',
        now
      )
    ).toBeNull();
  });
});

describe('account events', () => {
  it('reads PARTNER_ADDED and ignores other updates', () => {
    expect(
      parsePartnerAdded({
        event: 'PARTNER_ADDED',
        waba_info: { waba_id: '10', owner_business_id: '20' },
      })
    ).toEqual({ wabaId: '10', ownerBusinessId: '20' });
    expect(parsePartnerAdded({ event: 'VERIFIED_ACCOUNT' })).toBeNull();
    expect(
      parsePartnerAdded({ event: 'PARTNER_ADDED', waba_info: {} })
    ).toBeNull();
  });

  it('tells disconnects apart', () => {
    expect(
      parseDisconnect('account_update', { event: 'PARTNER_REMOVED' })
    ).toBe('PARTNER_REMOVED');
    expect(parseDisconnect('account_offboarded', {})).toBe(
      'ACCOUNT_OFFBOARDED'
    );
    expect(
      parseDisconnect('account_update', { event: 'PARTNER_ADDED' })
    ).toBeNull();
  });
});

describe('parseEchoes', () => {
  it('turns what the owner sent from the phone into outbound messages', () => {
    const out = parseEchoes({
      message_echoes: [
        {
          from: '558591331364',
          to: '+55 85 9298-0806',
          id: 'wamid.1',
          timestamp: '1760900000',
          type: 'text',
          text: { body: 'Oi!' },
        },
        {
          from: '558591331364',
          to: '558592980806',
          id: 'wamid.2',
          timestamp: '1760900001',
          type: 'image',
          image: {},
        },
        {
          from: '558591331364',
          id: 'wamid.3',
          type: 'text',
          text: { body: 'no recipient' },
        },
      ],
    });
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      id: 'wamid.1',
      customer: '558592980806',
      fromBusiness: true,
      text: 'Oi!',
      contentType: 'text',
      status: 'sent',
      timestamp: 1760900000,
    });
    expect(out[1]).toMatchObject({ contentType: 'image', text: '📷' });
  });
});

describe('parseHistory', () => {
  it('splits a thread into customer and business messages with their status', () => {
    const [chunk] = parseHistory(
      {
        history: [
          {
            metadata: { phase: 0, chunk_order: 1, progress: 40 },
            threads: [
              {
                id: '558592980806',
                messages: [
                  {
                    from: '558592980806',
                    id: 'h1',
                    timestamp: '100',
                    type: 'text',
                    text: { body: 'Olá' },
                    history_context: { status: 'READ' },
                  },
                  {
                    from: '558591331364',
                    to: '558592980806',
                    id: 'h2',
                    timestamp: '101',
                    type: 'text',
                    text: { body: 'Oi' },
                    history_context: { status: 'DELIVERED' },
                  },
                  {
                    from: '558592980806',
                    id: 'h3',
                    timestamp: '102',
                    type: 'media_placeholder',
                    history_context: { status: 'ERROR' },
                  },
                ],
              },
            ],
          },
        ],
      },
      '+55 85 9133-1364'
    );
    expect(chunk).toMatchObject({ phase: 0, progress: 40, declined: false });
    expect(
      chunk.messages.map((m) => [m.id, m.fromBusiness, m.status, m.customer])
    ).toEqual([
      ['h1', false, 'read', '558592980806'],
      ['h2', true, 'delivered', '558592980806'],
      ['h3', false, 'failed', '558592980806'],
    ]);
    expect(chunk.messages[2].text).toBe('📎');
  });

  it('flags a declined history share', () => {
    const [chunk] = parseHistory(
      { history: [{ metadata: { phase: 0 }, errors: [{ code: 2593109 }] }] },
      '1'
    );
    expect(chunk.declined).toBe(true);
    expect(chunk.messages).toEqual([]);
  });
});

describe('parseStateSync', () => {
  it('reads added and removed app contacts', () => {
    expect(
      parseStateSync({
        state_sync: [
          {
            type: 'contact',
            action: 'add',
            contact: {
              full_name: ' Ana Souza ',
              first_name: 'Ana',
              phone_number: '+55 11 98888-7777',
            },
          },
          {
            type: 'contact',
            action: 'remove',
            contact: { phone_number: '5511977776666' },
          },
          {
            type: 'contact',
            action: 'add',
            contact: { full_name: 'No phone' },
          },
        ],
      })
    ).toEqual([
      { action: 'add', phone: '5511988887777', name: 'Ana Souza' },
      { action: 'remove', phone: '5511977776666', name: '' },
    ]);
  });
});

describe('appSecretProof', () => {
  it('is the hex HMAC-SHA256 of the token', () => {
    expect(appSecretProof('token', 'secret')).toMatch(/^[0-9a-f]{64}$/);
    expect(appSecretProof('token', 'secret')).not.toBe(
      appSecretProof('token', 'other')
    );
  });
});
