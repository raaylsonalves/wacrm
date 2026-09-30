import { describe, it, expect } from 'vitest';
import { unsupportedTemplateReason } from './template-support';

describe('unsupportedTemplateReason', () => {
  it('accepts the formats the send path builds', () => {
    expect(
      unsupportedTemplateReason([
        { type: 'HEADER', format: 'IMAGE' },
        { type: 'BODY' },
        {
          type: 'BUTTONS',
          buttons: [{ type: 'URL' }, { type: 'QUICK_REPLY' }],
        },
      ])
    ).toBeNull();
    expect(unsupportedTemplateReason(undefined)).toBeNull();
  });

  it('flags limited-time offer, catalog buttons and location headers; carousels are sendable', () => {
    expect(
      unsupportedTemplateReason([{ type: 'BODY' }, { type: 'CAROUSEL' }])
    ).toBeNull();
    expect(unsupportedTemplateReason([{ type: 'LIMITED_TIME_OFFER' }])).toBe(
      'limited_time_offer'
    );
    expect(
      unsupportedTemplateReason([
        { type: 'BUTTONS', buttons: [{ type: 'MPM' }] },
      ])
    ).toBe('catalog');
    expect(
      unsupportedTemplateReason([{ type: 'HEADER', format: 'LOCATION' }])
    ).toBe('location_header');
  });
});
