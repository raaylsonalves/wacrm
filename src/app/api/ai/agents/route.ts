// ============================================================
// /api/ai/agents — multi-agent (specs/multi-agent-router.md).
//
//   GET  — list every agent on the account (no keys), for the
//          agents list screen and a router's agent picker.
//   POST — create a NEW agent (never the account's first/default
//          one — that's still /api/ai/config, unchanged, so an
//          account that never touches multi-agent keeps exactly the
//          same setup flow it always had).
//
// Deliberately leaner than /api/ai/config: no fallback chain, no
// embeddings key, no agenda tools on a non-default agent — those stay
// account-wide, owned by the default agent, per the spec's own
// non-goals ("RAG por agente nesta fase" stays account-shared).
// ============================================================

import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';
import { encrypt } from '@/lib/whatsapp/encryption';
import { validateAiCredentials } from '@/lib/ai/validate';
import { listAiAgents } from '@/lib/ai/config';
import { AiError, type AiProvider } from '@/lib/ai/types';
import { audit } from '@/lib/audit';
import { AI_PROVIDER_DEFAULT_MODEL } from '@/lib/ai/defaults';

const VALID_PROVIDERS: AiProvider[] = [
  'openai',
  'anthropic',
  'gemini',
  'openrouter',
];

function bad(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

export async function GET() {
  try {
    const { supabase, accountId } = await requireRole('viewer');
    const agents = await listAiAgents(supabase, accountId);
    return NextResponse.json({ agents });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin');

    const limit = checkRateLimit(
      `ai-agent-create:${userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') return bad('Invalid request body');

    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return bad('name is required');

    // Only the NAME is required. An agent is created "incomplete" — the
    // provider key and model are filled in on its edit page — so setting
    // up several agents (one per number, one per client) starts with
    // naming them, not with hunting for keys. Until a key is saved the
    // agent is switched off and `loadAiConfig` treats it as not
    // configured (an empty key), so it can never answer anyone.
    const provider = (body.provider ?? 'openai') as AiProvider;
    if (!VALID_PROVIDERS.includes(provider)) {
      return bad(
        'provider must be "openai", "anthropic", "gemini", or "openrouter"'
      );
    }
    const model =
      typeof body.model === 'string' && body.model.trim()
        ? body.model.trim()
        : AI_PROVIDER_DEFAULT_MODEL[provider];

    const apiKey = typeof body.api_key === 'string' ? body.api_key.trim() : '';

    const systemPrompt =
      typeof body.system_prompt === 'string' && body.system_prompt.trim()
        ? body.system_prompt.trim()
        : null;
    const isActive = body.is_active === true;
    const autoReplyEnabled = body.auto_reply_enabled === true;

    let maxPer = Number(body.auto_reply_max_per_conversation);
    if (!Number.isFinite(maxPer)) maxPer = 3;
    maxPer = Math.min(20, Math.max(1, Math.floor(maxPer)));

    const rawHandoff =
      typeof body.handoff_agent_id === 'string'
        ? body.handoff_agent_id.trim()
        : '';
    let handoffAgentId: string | null = null;
    if (rawHandoff) {
      const { data: member } = await supabase
        .from('profiles')
        .select('user_id')
        .eq('account_id', accountId)
        .eq('user_id', rawHandoff)
        .maybeSingle();
      if (!member)
        return bad('handoff_agent_id must be a member of this account');
      handoffAgentId = rawHandoff;
    }

    // A key that IS supplied is validated with the provider, as before.
    if (apiKey) {
      try {
        await validateAiCredentials({
          provider,
          model,
          apiKey,
          systemPrompt,
          isActive,
          autoReplyEnabled,
          autoReplyMaxPerConversation: maxPer,
          handoffAgentId: null,
          embeddingsApiKey: null,
          fallbacks: [],
          agendaEnabled: false,
        });
      } catch (err) {
        if (err instanceof AiError) {
          return NextResponse.json(
            { error: err.message, code: err.code },
            { status: 400 }
          );
        }
        console.error('[ai/agents POST] validation error:', err);
        return bad('Could not validate the API key with the provider.');
      }
    }

    // The account's FIRST agent is its default one (the fallback for every
    // number nobody else claims); later ones are additional.
    const { count: existingCount } = await supabase
      .from('ai_configs')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', accountId);
    const isFirst = (existingCount ?? 0) === 0;

    const { data: created, error: insErr } = await supabase
      .from('ai_configs')
      .insert({
        account_id: accountId,
        created_by: userId,
        name,
        is_default: isFirst,
        provider,
        model,
        api_key: apiKey ? encrypt(apiKey) : '',
        system_prompt: systemPrompt,
        // No key yet → off, whatever was asked for.
        is_active: apiKey ? isActive : false,
        auto_reply_enabled: apiKey ? autoReplyEnabled : false,
        auto_reply_max_per_conversation: maxPer,
        handoff_agent_id: handoffAgentId,
      })
      .select('id, name, provider, model, is_default, is_active')
      .single();

    if (insErr || !created) {
      console.error('[ai/agents POST] insert error:', insErr);
      return NextResponse.json(
        { error: 'Failed to create agent' },
        { status: 500 }
      );
    }

    void audit({
      accountId,
      actorUserId: userId,
      action: 'ai_agent.created',
      resourceType: 'ai_config',
      resourceId: created.id,
      metadata: { name, provider, model },
    });

    return NextResponse.json({ agent: created }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
