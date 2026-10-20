import { describe, expect, it } from 'vitest';
import {
  MEDIA_DEDUPE_MS,
  mediaPromptSection,
  mediaTools,
  parseMediaLibrary,
  recentlySent,
} from './media';

describe('media library', () => {
  it('keeps valid https pictures with a name, unique ids, max 10', () => {
    const lib = parseMediaLibrary([
      {
        id: 'tabela',
        name: 'Tabela',
        when: 'pede preços',
        url: 'https://x/a.jpg',
      },
      { id: 'tabela', name: 'Dup', url: 'https://x/b.jpg' },
      { name: 'Sem url' },
      { id: 'bad id!', name: 'VIP', url: 'https://x/v.jpg' },
      { name: 'http', url: 'http://x/insecure.jpg' },
      'junk',
    ]);
    expect(lib.map((i) => i.id)).toEqual(['tabela', 'badid']);
    const many = Array.from({ length: 15 }, (_, i) => ({
      id: `i${i}`,
      name: 'n',
      url: 'https://x',
    }));
    expect(parseMediaLibrary(many)).toHaveLength(10);
    expect(parseMediaLibrary(null)).toEqual([]);
  });

  it('offers the tool and the prompt list only when there are pictures', () => {
    expect(mediaTools([])).toEqual([]);
    expect(mediaPromptSection([])).toBeNull();
    const lib = parseMediaLibrary([
      {
        id: 'vip',
        name: 'Tabela VIP',
        when: 'pergunta preço da Área VIP',
        url: 'https://x/v.jpg',
      },
    ]);
    const params = mediaTools(lib)[0].parameters as {
      properties: { image_id: { enum: string[] } };
    };
    expect(params.properties.image_id.enum).toEqual(['vip']);
    expect(mediaPromptSection(lib)).toContain(
      'vip — Tabela VIP: pergunta preço da Área VIP'
    );
  });

  it('refuses the same picture inside the window', () => {
    const now = Date.parse('2026-10-20T15:00:00Z');
    const at = (ms: number) => new Date(now - ms).toISOString();
    const url = 'https://x/a.jpg';
    expect(
      recentlySent([{ media_url: url, created_at: at(60_000) }], url, now)
    ).toBe(true);
    expect(
      recentlySent(
        [{ media_url: url, created_at: at(MEDIA_DEDUPE_MS + 1) }],
        url,
        now
      )
    ).toBe(false);
    expect(
      recentlySent(
        [{ media_url: 'https://x/b.jpg', created_at: at(1) }],
        url,
        now
      )
    ).toBe(false);
  });
});
