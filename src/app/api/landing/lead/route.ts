// ============================================================
// POST /api/landing/lead — public contact form of the marketing page.
// Creates (or finds) the contact in the account named by
// LANDING_LEAD_ACCOUNT_ID and tags it, so a visitor lands in this
// deployment's own CRM. Unauthenticated by design: rate-limited per IP,
// a honeypot field drops bots, and nothing but name/phone/interest is
// accepted. Without the env var the form reports "not configured".
// ============================================================

import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/ai/admin-client';
import {
  findOrCreateContact,
  resolveAuditUserId,
  ContactError,
} from '@/lib/api/v1/contacts';
import { resolveImportTagIds } from '@/lib/contacts/resolve-import-tags';
import { LEAD_TAG, interestTag, parseLead } from '@/lib/landing/lead';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';

const LIMIT = { limit: 5, windowMs: 10 * 60_000 };

function clientIp(request: Request): string {
  const xff = request.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim();
  return request.headers.get('x-real-ip')?.trim() || 'unknown';
}

export async function POST(request: Request) {
  const accountId = process.env.LANDING_LEAD_ACCOUNT_ID;
  if (!accountId)
    return NextResponse.json({ error: 'not_configured' }, { status: 503 });

  const rl = checkRateLimit(`landing-lead:${clientIp(request)}`, LIMIT);
  if (!rl.success) return rateLimitResponse(rl);

  const body = (await request.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  // Honeypot: a field people never see. Bots fill it; answer as if it worked.
  if (body && typeof body.website === 'string' && body.website.trim()) {
    return NextResponse.json({ ok: true });
  }
  const parsed = parseLead(body);
  if (!parsed.ok)
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  const { lead } = parsed;

  try {
    const db = supabaseAdmin();
    const userId = await resolveAuditUserId(db, accountId);
    const { id } = await findOrCreateContact(db, accountId, userId, {
      phone: lead.phone,
      name: lead.name || null,
    });
    // Add the tags without touching the ones a returning contact has.
    const names = [LEAD_TAG, interestTag(lead.interest)];
    const { tagIdByKey } = await resolveImportTagIds(db, {
      accountId,
      userId,
      tagNames: names,
      canCreateTags: true,
    });
    const rows = names
      .map((n) => tagIdByKey.get(n.toLowerCase()))
      .filter((t): t is string => !!t)
      .map((tag_id) => ({ contact_id: id, tag_id }));
    if (rows.length) {
      const { error } = await db
        .from('contact_tags')
        .upsert(rows, {
          onConflict: 'contact_id,tag_id',
          ignoreDuplicates: true,
        });
      if (error) console.warn('[landing/lead] tagging failed:', error);
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof ContactError && err.status === 400) {
      return NextResponse.json({ error: 'invalid_phone' }, { status: 400 });
    }
    console.error('[landing/lead] failed:', err);
    return NextResponse.json({ error: 'failed' }, { status: 500 });
  }
}
