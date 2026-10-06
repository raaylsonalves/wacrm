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
    throw new MercadoPagoError(
      `Mercado Pago POST ${path.split('/').filter(Boolean)[0]} answered ${res.status}`,
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
        ...(input.endDate ? { end_date: input.endDate.toISOString() } : {}),
      },
    },
    idempotencyKey
  );
