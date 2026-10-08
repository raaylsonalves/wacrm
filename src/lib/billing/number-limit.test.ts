import { describe, expect, it } from 'vitest';
import { numberLimitFor } from './number-limit';

describe('numberLimitFor', () => {
  it('gives every standard plan one number', () => {
    for (const status of ['active', 'pending', 'past_due', 'canceled']) {
      expect(
        numberLimitFor({ max_whatsapp_numbers: null, subscription_status: status })
      ).toBe(1);
    }
  });

  it('leaves exempt accounts unlimited', () => {
    expect(
      numberLimitFor({ max_whatsapp_numbers: null, subscription_status: 'exempt' })
    ).toBeNull();
  });

  it('honours a custom limit set by the platform, even when exempt', () => {
    expect(
      numberLimitFor({ max_whatsapp_numbers: 4, subscription_status: 'active' })
    ).toBe(4);
    expect(
      numberLimitFor({ max_whatsapp_numbers: 2, subscription_status: 'exempt' })
    ).toBe(2);
  });
});
