import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';
import { loadAiConfig } from '@/lib/ai/config';
import { buildConversationContext } from '@/lib/ai/context';
import { generateReply } from '@/lib/ai/generate';
import { buildSystemPrompt } from '@/lib/ai/defaults';
import { summaryPromptSection, parseSummary } from '@/lib/ai/summary';
import { logAiUsage } from '@/lib/ai/usage';
import { supabaseAdmin } from '@/lib/ai/admin-client';
import { AiError } from '@/lib/ai/types';

/**
 * POST /api/ai/summary  (agent+)
 *
 * Body: { conversation_id }
 * Returns: { summary, next_step, generated_at } and stores it on the
 * conversation (migration 094) so the card shows it again for free.
 *
 * On demand only — it spends tokens on the account's own key. Uses the
 * account's default agent's provider, with the summary instruction in
 * place of a reply.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent');

    const userLimit = checkRateLimit(
      `ai-summary:${userId}`,
      RATE_LIMITS.aiDraft
    );
    if (!userLimit.success) return rateLimitResponse(userLimit);
    const accountLimit = checkRateLimit(
      `ai-summary-acct:${accountId}`,
      RATE_LIMITS.aiDraftAccount
    );
    if (!accountLimit.success) return rateLimitResponse(accountLimit);

    const body = await request.json().catch(() => null);
    const conversationId =
      body && typeof body.conversation_id === 'string'
        ? body.conversation_id
        : '';
    if (!conversationId) {
      return NextResponse.json(
        { error: 'conversation_id is required' },
        { status: 400 }
      );
    }

    // RLS scopes the SSR client to the caller's account.
    const { data: conversation } = await supabase
      .from('conversations')
      .select('id')
      .eq('id', conversationId)
      .maybeSingle();
    if (!conversation) {
      return NextResponse.json(
        { error: 'Conversation not found' },
        { status: 404 }
      );
    }

    const config = await loadAiConfig(supabase, accountId).catch((err) => {
      console.error('[ai/summary] loadAiConfig error:', err);
      throw new AiError('Stored API key could not be decrypted.', {
        code: 'key_decrypt_failed',
        status: 400,
      });
    });
    if (!config) {
      return NextResponse.json(
        {
          error:
            'AI assistant is not set up. Enable it in Settings → AI Assistant.',
          code: 'ai_not_configured',
        },
        { status: 400 }
      );
    }

    const messages = await buildConversationContext(supabase, conversationId);
    if (messages.length === 0) {
      return NextResponse.json(
        { error: 'No messages to summarise yet.', code: 'no_messages' },
        { status: 400 }
      );
    }

    const systemPrompt = `${buildSystemPrompt({
      userPrompt: config.systemPrompt,
      mode: 'draft',
    })}\n\n${summaryPromptSection()}`;

    // The history can end on our own turn; providers expect a user turn last.
    const { text, usage } = await generateReply({
      config,
      systemPrompt,
      messages: [
        ...messages,
        { role: 'user', content: '(Write the briefing for the teammate now.)' },
      ],
    });

    const parsed = parseSummary(text);
    if (!parsed) {
      return NextResponse.json(
        {
          error: 'The model did not return a usable summary.',
          code: 'bad_summary',
        },
        { status: 502 }
      );
    }

    const db = supabaseAdmin();
    const generatedAt = new Date().toISOString();
    await db
      .from('conversations')
      .update({ ai_summary: parsed, ai_summary_at: generatedAt })
      .eq('id', conversationId)
      .eq('account_id', accountId);
    try {
      void logAiUsage(db, {
        accountId,
        conversationId,
        agentId: config.id ?? null,
        mode: 'draft',
        provider: config.provider,
        model: config.model,
        usage,
      });
    } catch (logErr) {
      console.error('[ai/summary] usage log skipped:', logErr);
    }

    return NextResponse.json({ ...parsed, generated_at: generatedAt });
  } catch (err) {
    if (err instanceof AiError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.status }
      );
    }
    return toErrorResponse(err);
  }
}
