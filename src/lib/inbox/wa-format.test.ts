import { describe, it, expect } from 'vitest';
import { parseWhatsAppFormat as p } from './wa-format';

describe('parseWhatsAppFormat', () => {
  it('plain text is one segment', () => {
    expect(p('oi, tudo bem?')).toEqual([{ text: 'oi, tudo bem?' }]);
  });

  it('bold, italic, strike and mono', () => {
    expect(p('1. *Sistemas* sob medida')).toEqual([
      { text: '1. ' },
      { text: 'Sistemas', bold: true },
      { text: ' sob medida' },
    ]);
    expect(p('_talvez_ ~não~ ```code```')).toEqual([
      { text: 'talvez', italic: true },
      { text: ' ' },
      { text: 'não', strike: true },
      { text: ' ' },
      { text: 'code', mono: true },
    ]);
  });

  it('nests styles', () => {
    expect(p('*muito _bom_*')).toEqual([
      { text: 'muito ', bold: true },
      { text: 'bom', bold: true, italic: true },
    ]);
  });

  it('leaves markers that are not formatting', () => {
    expect(p('5 * 3 = 15 e 2 * 2')).toEqual([{ text: '5 * 3 = 15 e 2 * 2' }]);
    expect(p('meu_email_aqui@x.com')).toEqual([
      { text: 'meu_email_aqui@x.com' },
    ]);
    expect(p('* item\n* item')).toEqual([{ text: '* item\n* item' }]);
  });

  it('does not span lines', () => {
    expect(p('*abre\nfecha*')).toEqual([{ text: '*abre\nfecha*' }]);
  });
});
