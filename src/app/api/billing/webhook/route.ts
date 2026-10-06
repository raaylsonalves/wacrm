// ============================================================
// POST /api/billing/webhook — Mercado Pago notifications for both
// applications (subscriptions and Pix). See specs/mercadopago-checkout.md.
//
//   1. The x-signature HMAC is verified against the secret of each
//      application; no match (or no secret configured) -> 401.
//   2. The notification is recorded in billing_events, unique per
//      (source, event id): a retried delivery is acknowledged, not
//      re-applied (unless the first attempt never finished).
//   3. The body is NOT trusted. applyNotification re-reads the resource
//      from the Mercado Pago API and applies that.
//
// A 5xx makes Mercado Pago retry (every ~15 minutes); every outcome that
// retrying cannot fix answers 200.
// ============================================================

import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/ai/admin-client';
import { applyNotification } from '@/lib/billing/apply';
import { webhookSecrets } from '@/lib/billing/mercadopago';
import { identifyBillingSource } from '@/lib/billing/webhook-signature';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const url = new URL(request.url);
  const queryId = url.searchParams.get('data.id');

  const verified = identifyBillingSource(
    {
      xSignature: request.headers.get('x-signature'),
      xRequestId: request.headers.get('x-request-id'),
      dataId: queryId,
    },
    webhookSecrets(),
    // Reasons only (never secrets or signatures), so a 401 can be told
    // apart in the logs: malformed, stale, mismatch or no secret set.
    (source, reason) =>
      console.warn(`[billing/webhook] rejected (${source}): ${reason}`)
  );
  if (!verified) {
    return NextResponse.json({ error: 'invalid_signature' }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as {
    id?: string | number;
    type?: string;
    topic?: string;
    action?: string;
    data?: { id?: string | number };
  } | null;

  const dataId = String(queryId ?? body?.data?.id ?? '');
  const topic = String(
    body?.type ?? body?.topic ?? url.searchParams.get('type') ?? ''
  );
  if (!dataId || !topic) return NextResponse.json({ ok: true });

  const eventId = String(body?.id ?? `${topic}:${dataId}:${verified.ts}`);
  const db = supabaseAdmin();

  try {
    const { data: existing } = await db
      .from('billing_events')
      .select('id, processed_at')
      .eq('source', verified.source)
      .eq('event_id', eventId)
      .maybeSingle();
    if (existing?.processed_at) return NextResponse.json({ ok: true });

    let rowId = existing?.id as string | undefined;
    if (!rowId) {
      const { data: inserted, error } = await db
        .from('billing_events')
        .insert({
          source: verified.source,
          event_id: eventId,
          topic,
          raw: body ?? {},
        })
        .select('id')
        .single();
      if (error) {
        // Lost a race with a concurrent delivery of the same event.
        if (error.code === '23505') return NextResponse.json({ ok: true });
        throw error;
      }
      rowId = inserted.id as string;
    }

    const result = await applyNotification(db, verified.source, topic, dataId);
    await db
      .from('billing_events')
      .update({ processed_at: new Date().toISOString() })
      .eq('id', rowId);
    return NextResponse.json({ ok: true, result });
  } catch (err) {
    console.error('[billing/webhook] processing failed:', err);
    return NextResponse.json({ error: 'failed' }, { status: 500 });
  }
}
