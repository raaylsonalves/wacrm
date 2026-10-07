// ============================================================
// /api/platform/test-pix — a R$ 1,00 Pix the platform admins can pay to
// check the live Mercado Pago setup end to end (credentials, Pix key,
// webhook delivery), without touching any customer's subscription.
//
//   POST          create the order, return its QR code
//   GET ?id=...   the order's current status at Mercado Pago
//
// The order is not stored in billing_pix_orders, so when its webhook
// arrives it is recorded in billing_events and answered as
// 'unknown_resource': the delivery is proven, nothing is credited.
// ============================================================

import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import {
  MercadoPagoError,
  createPixOrder,
  extractPixPayment,
  getOrder,
} from '@/lib/billing/mercadopago';
import { isPlatformAdmin } from '@/lib/platform/admin';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const LIMIT = { limit: 5, windowMs: 10 * 60_000 };

async function guard() {
  const ctx = await getCurrentAccount({ allowUnpaid: true });
  return (await isPlatformAdmin(ctx.userId)) ? ctx : null;
}

export async function POST() {
  try {
    const ctx = await guard();
    if (!ctx) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
    const limit = checkRateLimit(`platform:test-pix:${ctx.userId}`, LIMIT);
    if (!limit.success) return rateLimitResponse(limit);

    const { data: userData } = await ctx.supabase.auth.getUser();
    const email = userData.user?.email;
    if (!email) {
      return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
    }
    try {
      const order = await createPixOrder(
        {
          externalReference: `platform-test-${randomUUID()}`,
          amountCents: 100,
          payerEmail: email,
          expiresIn: 'PT30M',
        },
        randomUUID()
      );
      const pix = extractPixPayment(order);
      return NextResponse.json({
        id: order.id,
        status: order.status,
        qrCode: pix.qrCode,
        qrCodeBase64: pix.qrCodeBase64,
      });
    } catch (err) {
      if (err instanceof MercadoPagoError) {
        console.error('[platform/test-pix]', err.message);
        return NextResponse.json(
          { error: 'provider_rejected', detail: err.message },
          { status: 502 }
        );
      }
      throw err;
    }
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function GET(request: Request) {
  try {
    if (!(await guard())) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 });
    }
    const id = new URL(request.url).searchParams.get('id') ?? '';
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
      return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
    }
    const order = await getOrder(id);
    return NextResponse.json({ id: order.id, status: order.status });
  } catch (err) {
    return toErrorResponse(err);
  }
}
