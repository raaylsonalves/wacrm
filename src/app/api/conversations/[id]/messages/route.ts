// ============================================================
// DELETE /api/conversations/[id]/messages — clear a conversation's
// history in place (specs/clear-conversation-history.md).
//
// Mirrors contacts/[id]/anonymize's shape: admin+ only (stricter than
// the `messages_modify` RLS policy alone, which permits DELETE down to
// `agent` — a bulk, irreversible wipe belongs above that routine-write
// bar), best-effort Storage cleanup for any message media, then the
// row delete. Unlike anonymize, this also resets the conversation's
// own denormalized fields (last message preview, unread count, AI
// auto-reply state) since nothing else will now that its messages are
// gone.
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';
import { parseStorageObjectUrl } from '@/lib/contacts/anonymize';

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireRole('admin');

    const limit = checkRateLimit(
      `admin:clearConversationHistory:${ctx.userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { id } = await params;

    const { data: conversation, error: convErr } = await ctx.supabase
      .from('conversations')
      .select('id')
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .maybeSingle();
    if (convErr) {
      console.error(
        '[DELETE /api/conversations/[id]/messages] conversation lookup failed:',
        convErr
      );
      return NextResponse.json(
        { error: 'Failed to load conversation' },
        { status: 500 }
      );
    }
    if (!conversation) {
      return NextResponse.json(
        { error: 'Conversation not found' },
        { status: 404 }
      );
    }

    // Best-effort: pull any message media out of Storage before the
    // rows go away. A failure here logs and continues — losing an
    // orphaned Storage object is a smaller problem than failing the
    // delete the admin actually asked for.
    const { data: mediaMessages, error: msgErr } = await ctx.supabase
      .from('messages')
      .select('media_url')
      .eq('conversation_id', id)
      .not('media_url', 'is', null);
    if (msgErr) {
      console.error(
        '[DELETE /api/conversations/[id]/messages] media lookup failed:',
        msgErr
      );
    } else {
      const pathsByBucket = new Map<string, string[]>();
      for (const row of mediaMessages ?? []) {
        const parsed = row.media_url
          ? parseStorageObjectUrl(row.media_url as string)
          : null;
        if (!parsed) continue;
        const bucket = pathsByBucket.get(parsed.bucket) ?? [];
        bucket.push(parsed.path);
        pathsByBucket.set(parsed.bucket, bucket);
      }
      for (const [bucket, paths] of pathsByBucket) {
        const { error: removeErr } = await ctx.supabase.storage
          .from(bucket)
          .remove(paths);
        if (removeErr) {
          console.error(
            `[DELETE /api/conversations/[id]/messages] storage remove failed (bucket=${bucket}):`,
            removeErr
          );
        }
      }
    }

    const { error: deleteErr } = await ctx.supabase
      .from('messages')
      .delete()
      .eq('conversation_id', id);
    if (deleteErr) {
      console.error(
        '[DELETE /api/conversations/[id]/messages] delete failed:',
        deleteErr
      );
      return NextResponse.json(
        { error: 'Failed to clear conversation history' },
        { status: 500 }
      );
    }

    // Nothing else resets these once the messages that drove them are
    // gone — a cleared thread should read as fresh, not as a
    // conversation with a stale preview or a bot still paused/handed
    // off from before.
    const { error: resetErr } = await ctx.supabase
      .from('conversations')
      .update({
        last_message_text: null,
        last_message_at: null,
        last_message_sender_type: null,
        unread_count: 0,
        ai_reply_count: 0,
        ai_autoreply_disabled: false,
        ai_handoff_summary: null,
      })
      .eq('id', id);
    if (resetErr) {
      console.error(
        '[DELETE /api/conversations/[id]/messages] conversation reset failed:',
        resetErr
      );
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
