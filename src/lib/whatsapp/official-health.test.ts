import { describe, expect, it } from 'vitest';
import { startsFailing } from './official-health';

describe('startsFailing', () => {
  it('notifies only when a healthy number starts failing', () => {
    expect(startsFailing(null, 'token expired')).toBe(true);
    expect(startsFailing('token expired', 'token expired')).toBe(false);
    expect(startsFailing('token expired', null)).toBe(false);
    expect(startsFailing(null, null)).toBe(false);
  });
});
