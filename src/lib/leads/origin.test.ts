import { describe, expect, it } from 'vitest';
import { codesIn, detectOrigin, parseLossReason, slugCode, trackingUrl } from './origin';

const links = [{ code: 'insta', label: 'Instagram bio' }];

describe('detectOrigin', () => {
  it('an ad referral wins', () => {
    expect(detectOrigin({ source_id: '123', headline: 'Promo', source_type: 'ad' }, 'oi #insta', links)).toEqual({
      source: 'ad',
      detail: { source_id: '123', source_type: 'ad', headline: 'Promo' },
    });
  });
  it('a known #code is a link', () => {
    expect(detectOrigin(null, 'Olá! Quero saber mais #INSTA', links)).toEqual({
      source: 'link',
      detail: { code: 'insta', label: 'Instagram bio' },
    });
  });
  it('an unknown code or no code is organic', () => {
    expect(detectOrigin(null, 'oi #outro', links).source).toBe('organic');
    expect(detectOrigin({}, 'oi', links).source).toBe('organic');
  });
});

describe('helpers', () => {
  it('codes, slugs and urls', () => {
    expect(codesIn('a #x1 b #Y_2')).toEqual(['x1', 'y_2']);
    expect(slugCode(' Panfleto Março! ')).toBe('panfleto-marco');
    expect(trackingUrl('+55 (85) 9999-0000', 'Olá!', 'insta')).toBe('https://wa.me/558599990000?text=Ol%C3%A1!%20%23insta');
  });
  it('parseLossReason', () => {
    expect(parseLossReason('Reason: price')).toBe('price');
    expect(parseLossReason('no_response')).toBe('no_response');
    expect(parseLossReason('nada')).toBeNull();
  });
});
