import { describe, it, expect } from 'vitest';
import {
  brandMarkSvgDataUrl,
  buildTabTitle,
  faviconHrefForAccount,
  safeLogoUrl,
  sectionKeyForPath,
} from './tab';

describe('sectionKeyForPath', () => {
  it('maps the first segment to a sidebar key', () => {
    expect(sectionKeyForPath('/inbox')).toBe('inbox');
    expect(sectionKeyForPath('/agents/abc')).toBe('aiAgents');
    expect(sectionKeyForPath('/automations/1/edit')).toBe('automations');
  });
  it('null for unknown or root paths', () => {
    expect(sectionKeyForPath('/')).toBeNull();
    expect(sectionKeyForPath('/whatever')).toBeNull();
  });
});

describe('buildTabTitle', () => {
  it('section — account name', () => {
    expect(buildTabTitle('Caixa de entrada', 'Clínica X')).toBe(
      'Caixa de entrada — Clínica X'
    );
  });
  it('falls back to the app name when the account has no display name', () => {
    expect(buildTabTitle('Contatos', null)).toBe('Contatos — wacrm');
    expect(buildTabTitle(null, '  ')).toBe('wacrm');
  });
});

describe('favicon', () => {
  it('only accepts http(s) logo URLs', () => {
    expect(safeLogoUrl('https://cdn.example.com/logo.png')).toBe(
      'https://cdn.example.com/logo.png'
    );
    expect(safeLogoUrl('javascript:alert(1)')).toBeNull();
    expect(safeLogoUrl('data:image/png;base64,xx')).toBeNull();
    expect(safeLogoUrl('not a url')).toBeNull();
  });

  it('builds a colored brand mark only from a valid hex', () => {
    const url = brandMarkSvgDataUrl('#16a34a');
    expect(url?.startsWith('data:image/svg+xml,')).toBe(true);
    expect(decodeURIComponent(url!)).toContain('fill="#16a34a"');
    expect(brandMarkSvgDataUrl('red"/><script>')).toBeNull();
  });

  it('logo wins over color; neither → null (keep default icon)', () => {
    expect(
      faviconHrefForAccount({
        logo_url: 'https://x.test/l.png',
        brand_color: '#000000',
      })
    ).toBe('https://x.test/l.png');
    expect(
      faviconHrefForAccount({ logo_url: null, brand_color: '#000000' })
    ).toMatch(/^data:image\/svg\+xml,/);
    expect(
      faviconHrefForAccount({ logo_url: null, brand_color: null })
    ).toBeNull();
    expect(faviconHrefForAccount(null)).toBeNull();
  });
});
