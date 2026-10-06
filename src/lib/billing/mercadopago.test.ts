import { describe, expect, it } from 'vitest';
import { extractPixPayment } from './mercadopago';

describe('extractPixPayment', () => {
  it('reads the QR, copia-e-cola and ticket link of the first payment', () => {
    expect(
      extractPixPayment({
        id: 'ORD1',
        transactions: {
          payments: [
            {
              payment_method: {
                qr_code: '0002...',
                qr_code_base64: 'iVBOR...',
                ticket_url: 'https://www.mercadopago.com.br/payments/1/ticket',
              },
            },
          ],
        },
      })
    ).toEqual({
      qrCode: '0002...',
      qrCodeBase64: 'iVBOR...',
      ticketUrl: 'https://www.mercadopago.com.br/payments/1/ticket',
    });
  });

  it('returns nulls when the order carries no payment yet', () => {
    expect(extractPixPayment({ id: 'ORD2' })).toEqual({
      qrCode: null,
      qrCodeBase64: null,
      ticketUrl: null,
    });
  });
});
