// Thin server-side client for the Mercado Pago endpoints the webhook needs.
// Each application (subscriptions / Pix) has its own access token, so the
// caller names the source. Tokens come from env vars and never leave the
// server; nothing here logs a request or response body.

import type { BillingSource } from './webhook-signature';

const API = 'https://api.mercadopago.com';

export function accessTokenFor(source: BillingSource): string | null {
  const v =
    source === 'subs'
      ? process.env.MERCADOPAGO_SUBS_ACCESS_TOKEN
      : process.env.MERCADOPAGO_PIX_ACCESS_TOKEN;
  return v && v.trim() ? v.trim() : null;
}

export function webhookSecrets(): Record<BillingSource, string | undefined> {
  return {
    subs: process.env.MERCADOPAGO_SUBS_WEBHOOK_SECRET || undefined,
    pix: process.env.MERCADOPAGO_PIX_WEBHOOK_SECRET || undefined,
  };
}

export class MercadoPagoError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

async function mpGet<T>(source: BillingSource, path: string): Promise<T> {
  const token = accessTokenFor(source);
  if (!token) throw new MercadoPagoError('access token not configured', 500);
  const res = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    cache: 'no-store',
  });
  if (!res.ok) {
    throw new MercadoPagoError(
      `Mercado Pago GET ${path.split('/').filter(Boolean)[0]} answered ${res.status}`,
      res.status
    );
  }
  return (await res.json()) as T;
}

// Only the fields we read; the rest of each payload is ignored.

export interface MpOrder {
  id: string;
  status?: string;
  status_detail?: string;
  total_amount?: string;
  external_reference?: string;
  transactions?: {
    payments?: Array<{
      id?: string;
      status?: string;
      payment_method?: {
        ticket_url?: string;
        qr_code?: string;
        qr_code_base64?: string;
      };
    }>;
  };
}

export interface MpPreapproval {
  id: string;
  status?: string;
  external_reference?: string;
  payer_id?: number | string;
  next_payment_date?: string;
  auto_recurring?: { transaction_amount?: number };
}

export interface MpAuthorizedPayment {
  id: number | string;
  preapproval_id?: string;
  status?: string;
  transaction_amount?: number;
  debit_date?: string;
}

export const getOrder = (id: string) =>
  mpGet<MpOrder>('pix', `/v1/orders/${encodeURIComponent(id)}`);

export const getPreapproval = (id: string) =>
  mpGet<MpPreapproval>('subs', `/preapproval/${encodeURIComponent(id)}`);

export const getAuthorizedPayment = (id: string) =>
  mpGet<MpAuthorizedPayment>(
    'subs',
    `/authorized_payments/${encodeURIComponent(id)}`
  );

async function mpPost<T>(
  source: BillingSource,
  path: string,
  body: unknown,
  idempotencyKey: string
): Promise<T> {
  const token = accessTokenFor(source);
  if (!token) throw new MercadoPagoError('access token not configured', 500);
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify(body),
    cache: 'no-store',
  });
  if (!res.ok) {
    // Mercado Pago's own reason ("Unsupported_credit_card_for_recurring_
    // payment", "Both payer and collector must be real or test users"…) is
    // what tells sandbox rules apart from real problems. It carries no
    // secrets, so it goes in the message for the server log.
    const reason = await res
      .json()
      .then((j: { message?: string; code?: string }) =>
        [j.code, j.message].filter(Boolean).join(': ')
      )
      .catch(() => '');
    throw new MercadoPagoError(
      `Mercado Pago POST ${path.split('/').filter(Boolean)[0]} answered ${res.status}${reason ? ` (${reason.slice(0, 200)})` : ''}`,
      res.status
    );
  }
  return (await res.json()) as T;
}

export interface CreatePreapprovalInput {
  reason: string;
  externalReference: string;
  payerEmail: string;
  cardTokenId: string;
  amount: number;
  /** Set for plans that end (annual = 12 months); omitted otherwise. */
  endDate?: Date;
  /** First charge date; omitted = now. Used to resume after a period
   *  that is already paid, so that month is not charged twice. */
  startDate?: Date;
  backUrl: string;
}

/** Card subscription charged monthly, created authorized from a card token
 *  produced in the browser (the card number never reaches this server). */
export const createPreapproval = (
  input: CreatePreapprovalInput,
  idempotencyKey: string
) =>
  mpPost<MpPreapproval>(
    'subs',
    '/preapproval',
    {
      reason: input.reason,
      external_reference: input.externalReference,
      payer_email: input.payerEmail,
      card_token_id: input.cardTokenId,
      status: 'authorized',
      back_url: input.backUrl,
      auto_recurring: {
        frequency: 1,
        frequency_type: 'months',
        transaction_amount: input.amount,
        currency_id: 'BRL',
        ...(input.startDate
          ? { start_date: input.startDate.toISOString() }
          : {}),
        ...(input.endDate ? { end_date: input.endDate.toISOString() } : {}),
      },
    },
    idempotencyKey
  );

export interface PixPayment {
  qrCode: string | null;
  qrCodeBase64: string | null;
  ticketUrl: string | null;
}

/** The QR / copia-e-cola / ticket link out of a created Pix order. */
export function extractPixPayment(order: MpOrder): PixPayment {
  const m = order.transactions?.payments?.[0]?.payment_method;
  return {
    qrCode: m?.qr_code ?? null,
    qrCodeBase64: m?.qr_code_base64 ?? null,
    ticketUrl: m?.ticket_url ?? null,
  };
}

export interface CreatePixOrderInput {
  externalReference: string;
  /** Centavos; sent to Mercado Pago as a "197.00" string. */
  amountCents: number;
  payerEmail: string;
  /** ISO 8601 duration, 30 minutes to 30 days. */
  expiresIn: string;
}

/** A single Pix charge through the Orders API (automatic processing). */
export const createPixOrder = (
  input: CreatePixOrderInput,
  idempotencyKey: string
) => {
  const amount = (input.amountCents / 100).toFixed(2);
  return mpPost<MpOrder>(
    'pix',
    '/v1/orders',
    {
      type: 'online',
      total_amount: amount,
      external_reference: input.externalReference,
      processing_mode: 'automatic',
      transactions: {
        payments: [
          {
            amount,
            payment_method: { id: 'pix', type: 'bank_transfer' },
            expiration_time: input.expiresIn,
          },
        ],
      },
      // Sandbox rule: a Pix order only gets approved by Mercado Pago when
      // payer.first_name is APRO (test Pix cannot be paid from a bank app).
      // Test credentials do not look different from live ones, so sandbox
      // is an explicit switch (MERCADOPAGO_SANDBOX=1); never set it in
      // production.
      payer: {
        email: input.payerEmail,
        ...(process.env.MERCADOPAGO_SANDBOX === '1'
          ? { first_name: 'APRO' }
          : {}),
      },
    },
    idempotencyKey
  );
};

export const cancelOrder = (id: string, idempotencyKey: string) =>
  mpPost<MpOrder>(
    'pix',
    `/v1/orders/${encodeURIComponent(id)}/cancel`,
    {},
    idempotencyKey
  );

async function mpPut<T>(
  source: BillingSource,
  path: string,
  body: unknown
): Promise<T> {
  const token = accessTokenFor(source);
  if (!token) throw new MercadoPagoError('access token not configured', 500);
  const res = await fetch(`${API}${path}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
    cache: 'no-store',
  });
  if (!res.ok) {
    throw new MercadoPagoError(
      `Mercado Pago PUT ${path.split('/').filter(Boolean)[0]} answered ${res.status}`,
      res.status
    );
  }
  return (await res.json()) as T;
}

/** Stops a card subscription at Mercado Pago (no further charges). */
export const cancelPreapproval = (id: string) =>
  mpPut<MpPreapproval>('subs', `/preapproval/${encodeURIComponent(id)}`, {
    status: 'cancelled',
  });

/**
 * Swaps the card a subscription charges. A declined charge that is still
 * being retried (up to 4 times in 10 days) is retried on the new card.
 */
export const updatePreapprovalCard = (id: string, cardTokenId: string) =>
  mpPut<MpPreapproval>('subs', `/preapproval/${encodeURIComponent(id)}`, {
    card_token_id: cardTokenId,
  });
