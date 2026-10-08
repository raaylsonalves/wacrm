// ============================================================
// GET /api/conversations/{id}/eligible-assignees
//
// Which account members MessageThread's assign dropdown should
// offer for this one conversation, per its channel's routing policy
// (specs/channel-routing-responsibles.md). `restricted: false` means
// every member is eligible (no policy configured) — the dashboard
// shows the full member list unfiltered in that case.
// ============================================================

import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { eligibleAssigneesForConversation } from '@/lib/channels/routing';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireRole('viewer');
    const { id } = await params;

    const { data: conversation, error } = await ctx.supabase
      .from('conversations')
      .select('id, whatsapp_channel_id, whatsapp_config_id')
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .maybeSingle();
    if (error) {
      console.error('[eligible-assignees GET] fetch error:', error);
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

    const eligible = await eligibleAssigneesForConversation(
      ctx.supabase,
      ctx.accountId,
      conversation.whatsapp_channel_id ?? null,
      conversation.whatsapp_config_id ?? null
    );

    return NextResponse.json({
      restricted: eligible !== null,
      eligibleUserIds: eligible ?? [],
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
