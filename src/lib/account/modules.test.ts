import { describe, it, expect } from 'vitest';
import { isPathAllowed, moduleForPath } from './modules';

describe('moduleForPath', () => {
  it('maps pages and nested routes', () => {
    expect(moduleForPath('/inbox')).toBe('inbox');
    expect(moduleForPath('/agents/123')).toBe('ai');
    expect(moduleForPath('/flows')).toBe('ai');
    expect(moduleForPath('/dashboard')).toBeNull();
    expect(moduleForPath('/notifications')).toBeNull();
  });

  it('splits settings into channels and the rest', () => {
    expect(moduleForPath('/settings?tab=whatsapp')).toBe('channels');
    expect(moduleForPath('/settings')).toBe('settings');
  });
});

describe('isPathAllowed', () => {
  const attendance = ['inbox', 'contacts', 'agenda'];

  it('null modules means everything', () => {
    expect(isPathAllowed('/agents', null, false)).toBe(true);
  });

  it('hides what was not bought', () => {
    expect(isPathAllowed('/agents', attendance, false)).toBe(false);
    expect(isPathAllowed('/agenda', attendance, false)).toBe(true);
    expect(isPathAllowed('/dashboard', attendance, false)).toBe(true);
  });

  it('operators bypass', () => {
    expect(isPathAllowed('/agents', attendance, true)).toBe(true);
  });
});
