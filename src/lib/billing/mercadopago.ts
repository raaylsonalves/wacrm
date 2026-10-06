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
