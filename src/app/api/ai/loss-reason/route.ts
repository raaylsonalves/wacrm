import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';
import { loadAgentForConversation } from '@/lib/ai/channel-agent';
import { buildConversationContext } from '@/lib/ai/context';
import { generateReply } from '@/lib/ai/generate';
import { logAiUsage } from '@/lib/ai/usage';
import { supabaseAdmin } from '@/lib/ai/admin-client';
import { AiError } from '@/lib/ai/types';
import { LOSS_REASONS, parseLossReason } from '@/lib/leads/origin';

/**
 * POST /api/ai/loss-reason  (agent+)
 *
 * Body: { conversation_id }
 * Returns: { reason, note } — a suggestion for the "why was it lost?"
 * question (migration 134). Nothing is saved: the person confirms in the
 * deal panel. On demand only; spends tokens on the account's own key.
 */
const PROMPT = `You classify why a sales opportunity was lost, from a WhatsApp conversation between a business and a customer.
Answer with exactly two lines:
REASON: one of ${LOSS_REASONS.join(', ')}
NOTE: one short sentence, in the conversation's language, with the evidence (max 140 characters)
Meanings: price = found it expensive; timing = not now / later; competitor = chose someone else; no_response = stopped replying; not_fit = what we offer does not fit the need; other = anything else.`;

export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent');

    const userLimit = checkRateLimit(`ai-loss:${userId}`, RATE_LIMITS.aiDraft);
    if (!userLimit.success) return rateLimitResponse(userLimit);
    const accountLimit = checkRateLimit(`ai-loss-acct:${accountId}`, RATE_LIMITS.aiDraftAccount);
    if (!accountLimit.success) return rateLimitResponse(accountLimit);

    const body = await request.json().catch(() => null);
    const conversationId = body && typeof body.conversation_id === 'string' ? body.conversation_id : '';
    if (!conversationId) {
      return NextResponse.json({ error: 'conversation_id is required' }, { status: 400 });
    }

    // RLS scopes the SSR client to the caller's account.
    const { data: conversation } = await supabase
      .from('conversations')
      .select('id')
      .eq('id', conversationId)
      .maybeSingle();
    if (!conversation) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
    }

    const config = await loadAgentForConversation(supabase, accountId, conversationId).catch((err) => {
      console.error('[ai/loss-reason] loadAiConfig error:', err);
      throw new AiError('Stored API key could not be decrypted.', { code: 'key_decrypt_failed', status: 400 });
    });
    if (!config) {
      return NextResponse.json(
        { error: 'AI assistant is not set up.', code: 'ai_not_configured' },
        { status: 400 }
      );
    }

    const messages = await buildConversationContext(supabase, conversationId);
    if (messages.length === 0) {
      return NextResponse.json({ error: 'No messages yet.', code: 'no_messages' }, { status: 400 });
    }

    const { text, usage } = await generateReply({
      config,
      systemPrompt: PROMPT,
      messages: [...messages, { role: 'user', content: '(Classify the loss now.)' }],
    });

    const reason = parseLossReason(text.match(/REASON:\s*(.+)/i)?.[1] ?? text);
    const note = (text.match(/NOTE:\s*(.+)/i)?.[1] ?? '').trim().slice(0, 300);
    if (!reason) {
      return NextResponse.json({ error: 'No usable answer.', code: 'bad_answer' }, { status: 502 });
    }

    try {
      void logAiUsage(supabaseAdmin(), {
        accountId,
        conversationId,
        agentId: config.id ?? null,
        mode: 'draft',
        provider: config.provider,
        model: config.model,
        usage,
      });
    } catch (logErr) {
      console.error('[ai/loss-reason] usage log skipped:', logErr);
    }

    return NextResponse.json({ reason, note });
  } catch (err) {
    if (err instanceof AiError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    }
    return toErrorResponse(err);
  }
}
