// ============================================================
// POST /api/contacts/[id]/anonymize — LGPD "right to be forgotten".
//
// Anonymizes a contact in place rather than deleting it: PII fields
// on `contacts` are wiped (lib/contacts/anonymize.ts), any message
// media is removed from Storage and its `media_url` nulled, and
// everything else — conversations, messages, deals, activities —
// stays put with its original timestamps. Admin+ only: this is a
// one-way action for the contact (undoing it means re-entering the
// customer's data by hand) even though it never deletes a row.
//
// Idempotent: a contact that's already anonymized just returns
// success with `alreadyAnonymized: true` instead of re-wiping
// already-blank fields or erroring.
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';
import {
  buildAnonymizedContactFields,
  parseStorageObjectUrl,
} from '@/lib/contacts/anonymize';

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireRole('admin');

    const limit = checkRateLimit(
      `admin:contactAnonymize:${ctx.userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { id } = await params;

    const { data: contact, error: contactErr } = await ctx.supabase
      .from('contacts')
      .select('id, anonymized_at')
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .maybeSingle();

    if (contactErr) {
      console.error(
        '[POST /api/contacts/[id]/anonymize] lookup failed:',
        contactErr
      );
      return NextResponse.json(
        { error: 'Failed to load contact' },
        { status: 500 }
      );
    }
    if (!contact) {
      return NextResponse.json({ error: 'Contact not found' }, { status: 404 });
    }
    if (contact.anonymized_at) {
      return NextResponse.json({ success: true, alreadyAnonymized: true });
    }

    // 1) Find every message with media across this contact's
    //    conversations, so the media can be pulled from Storage
    //    before the contact record itself is wiped.
    const { data: conversations, error: convErr } = await ctx.supabase
      .from('conversations')
      .select('id')
      .eq('contact_id', id);
    if (convErr) {
      console.error(
        '[POST /api/contacts/[id]/anonymize] conversations lookup failed:',
        convErr
      );
      return NextResponse.json(
        { error: 'Failed to load conversations' },
        { status: 500 }
      );
    }

    const conversationIds = (conversations ?? []).map((c) => c.id as string);
    let mediaDeleted = 0;

    if (conversationIds.length > 0) {
      const { data: mediaMessages, error: msgErr } = await ctx.supabase
        .from('messages')
        .select('id, media_url')
        .in('conversation_id', conversationIds)
        .not('media_url', 'is', null);
      if (msgErr) {
        console.error(
          '[POST /api/contacts/[id]/anonymize] messages lookup failed:',
          msgErr
        );
        return NextResponse.json(
          { error: 'Failed to load messages' },
          { status: 500 }
        );
      }

      // Group storage paths by bucket — `.remove()` takes one bucket
      // at a time, and in practice everything here is `chat-media`,
      // but nothing enforces that.
      const pathsByBucket = new Map<string, string[]>();
      const messageIds: string[] = [];
      for (const msg of mediaMessages ?? []) {
        messageIds.push(msg.id as string);
        const parsed = msg.media_url
          ? parseStorageObjectUrl(msg.media_url as string)
          : null;
        if (!parsed) continue;
        const bucket = pathsByBucket.get(parsed.bucket) ?? [];
        bucket.push(parsed.path);
        pathsByBucket.set(parsed.bucket, bucket);
      }

      // Best-effort: a Storage failure shouldn't block anonymizing the
      // contact's identity, which is the higher-priority half of the
      // request. Log and keep going.
      for (const [bucket, paths] of pathsByBucket) {
        const { error: removeErr, data: removed } = await ctx.supabase.storage
          .from(bucket)
          .remove(paths);
        if (removeErr) {
          console.error(
            `[POST /api/contacts/[id]/anonymize] storage remove failed (bucket=${bucket}):`,
            removeErr
          );
        } else {
          mediaDeleted += removed?.length ?? 0;
        }
      }

      if (messageIds.length > 0) {
        const { error: clearErr } = await ctx.supabase
          .from('messages')
          .update({ media_url: null })
          .in('id', messageIds);
        if (clearErr) {
          console.error(
            '[POST /api/contacts/[id]/anonymize] clearing media_url failed:',
            clearErr
          );
        }
      }
    }

    // 2) Wipe the contact's own PII fields.
    const { error: updateErr } = await ctx.supabase
      .from('contacts')
      .update(buildAnonymizedContactFields(id))
      .eq('id', id)
      .eq('account_id', ctx.accountId);

    if (updateErr) {
      console.error(
        '[POST /api/contacts/[id]/anonymize] contact update failed:',
        updateErr
      );
      return NextResponse.json(
        { error: 'Failed to anonymize contact' },
        { status: 500 }
      );
    }

    return NextResponse.json({ success: true, mediaDeleted });
  } catch (err) {
    return toErrorResponse(err);
  }
}
