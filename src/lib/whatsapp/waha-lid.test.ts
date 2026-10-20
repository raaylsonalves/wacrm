import { describe, expect, it } from 'vitest';
import { phoneFromWahaAlt, toWahaChatId } from './waha-api';

describe('WhatsApp privacy ids (@lid)', () => {
  it('reads the number NOWEB sends next to the LID', () => {
    expect(
      phoneFromWahaAlt({
        _data: {
          key: {
            remoteJid: '31886072111283@lid',
            remoteJidAlt: '5585999998888@s.whatsapp.net',
          },
        },
      })
    ).toBe('5585999998888');
    expect(
      phoneFromWahaAlt({
        _data: { key: { senderPn: '5585999998888:12@s.whatsapp.net' } },
      })
    ).toBe('5585999998888');
  });

  it('gives up without a number', () => {
    expect(phoneFromWahaAlt({})).toBeNull();
    expect(
      phoneFromWahaAlt({ _data: { key: { remoteJidAlt: '1@lid' } } })
    ).toBeNull();
  });

  it('replies to an unresolved LID as-is', () => {
    expect(toWahaChatId('31886072111283@lid')).toBe('31886072111283@lid');
    expect(toWahaChatId('+55 85 99999-8888')).toBe('5585999998888@c.us');
  });
});

describe('wahaMessageId', () => {
  it('reads the id whatever the engine', async () => {
    const { wahaMessageId } = await import('./waha-api');
    expect(wahaMessageId({ id: 'abc' })).toBe('abc');
    expect(wahaMessageId({ key: { id: '3EB0' } })).toBe('3EB0');
    expect(wahaMessageId({ id: { _serialized: 'true_1@c.us_X' } })).toBe(
      'true_1@c.us_X'
    );
    expect(wahaMessageId(null)).toBe('');
  });
});
