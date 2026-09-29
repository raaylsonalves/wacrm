// ============================================================
// /api/ai/agents/[id] — one non-default agent (specs/multi-agent-
// router.md). The default agent is still only ever edited through
// /api/ai/config — this route 404s on it, so there is exactly one
// way to touch that row and no risk of the two routes racing each
// other's writes.
// ============================================================

import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';
import { encrypt, decrypt } from '@/lib/whatsapp/encryption';
import { validateAiCredentials } from '@/lib/ai/validate';
import { AiError, type AiProvider } from '@/lib/ai/types';
import { audit } from '@/lib/audit';
import { cleanHandoffKeywords } from '@/lib/ai/handoff-keywords';
import { parseTranscriptionModel } from '@/lib/ai/transcribe';
import { parseVoiceMode, parseVoiceName } from '@/lib/ai/voice-reply';

const VALID_PROVIDERS: AiProvider[] = [
  'openai',
  'anthropic',
  'gemini',
  'openrouter',
];

function bad(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

async function loadOwnedNonDefaultAgent(
  supabase: Awaited<ReturnType<typeof requireRole>>['supabase'],
  accountId: string,
  id: string
) {
  const { data, error } = await supabase
    .from('ai_configs')
    .select('*')
    .eq('id', id)
    .eq('account_id', accountId)
    .eq('is_default', false)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { supabase, accountId } = await requireRole('viewer');
    const { id } = await params;
    const agent = await loadOwnedNonDefaultAgent(supabase, accountId, id);
    if (!agent)
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 });

    const { api_key, ...safe } = agent;
    return NextResponse.json({ agent: { ...safe, has_key: !!api_key } });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin');
    const { id } = await params;

    const limit = checkRateLimit(
      `ai-agent-update:${userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const existing = await loadOwnedNonDefaultAgent(supabase, accountId, id);
    if (!existing)
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 });

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') return bad('Invalid request body');

    const update: Record<string, unknown> = {};

    if ('name' in body) {
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!name) return bad('name cannot be empty');
      update.name = name;
    }
    if ('system_prompt' in body) {
      update.system_prompt =
        typeof body.system_prompt === 'string' && body.system_prompt.trim()
          ? body.system_prompt.trim()
          : null;
    }
    if ('is_active' in body) update.is_active = body.is_active === true;
    if ('auto_reply_enabled' in body) {
      update.auto_reply_enabled = body.auto_reply_enabled === true;
    }
    if ('auto_reply_max_per_conversation' in body) {
      let maxPer = Number(body.auto_reply_max_per_conversation);
      if (!Number.isFinite(maxPer))
        maxPer = existing.auto_reply_max_per_conversation;
      update.auto_reply_max_per_conversation = Math.min(
        20,
        Math.max(1, Math.floor(maxPer))
      );
    }
    if ('transcription_model' in body) {
      update.transcription_model = parseTranscriptionModel(body.transcription_model);
    }
    if ('voice_reply_mode' in body) update.voice_reply_mode = parseVoiceMode(body.voice_reply_mode);
    if ('voice_name' in body) update.voice_name = parseVoiceName(body.voice_name);
    if ('handoff_keywords' in body) {
      update.handoff_keywords = cleanHandoffKeywords(body.handoff_keywords);
    }
    if ('handoff_agent_id' in body) {
      const raw =
        typeof body.handoff_agent_id === 'string'
          ? body.handoff_agent_id.trim()
          : '';
      if (raw) {
        const { data: member } = await supabase
          .from('profiles')
          .select('user_id')
          .eq('account_id', accountId)
          .eq('user_id', raw)
          .maybeSingle();
        if (!member)
          return bad('handoff_agent_id must be a member of this account');
        update.handoff_agent_id = raw;
      } else {
        update.handoff_agent_id = null;
      }
    }

    const providerChanging =
      'provider' in body || 'model' in body || 'api_key' in body;
    let provider = existing.provider as AiProvider;
    let model = existing.model as string;
    let apiKeyPlain: string;

    if (providerChanging) {
      provider = (body.provider as AiProvider) ?? existing.provider;
      if (!VALID_PROVIDERS.includes(provider)) {
        return bad(
          'provider must be "openai", "anthropic", "gemini", or "openrouter"'
        );
      }
      model =
        typeof body.model === 'string' ? body.model.trim() : existing.model;
      if (!model) return bad('model is required');

      const rawKey =
        typeof body.api_key === 'string' ? body.api_key.trim() : '';
      // An agent created with just a name has no stored key yet.
      if (!rawKey && !existing.api_key) return bad('api_key is required');
      if (rawKey) {
        apiKeyPlain = rawKey;
      } else {
        try {
          apiKeyPlain = decrypt(existing.api_key);
        } catch {
          return bad(
            'Stored API key could not be decrypted — re-enter your key.'
          );
        }
      }

      try {
        await validateAiCredentials({
          provider,
          model,
          apiKey: apiKeyPlain,
          systemPrompt: null,
          isActive: true,
          autoReplyEnabled: false,
          autoReplyMaxPerConversation: 3,
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
        console.error('[ai/agents PATCH] validation error:', err);
        return bad('Could not validate the API key with the provider.');
      }

      update.provider = provider;
      update.model = model;
      if (rawKey) update.api_key = encrypt(rawKey);
    }

    const { error: upErr } = await supabase
      .from('ai_configs')
      .update(update)
      .eq('id', id);
    if (upErr) {
      console.error('[ai/agents PATCH] update error:', upErr);
      return NextResponse.json(
        { error: 'Failed to update agent' },
        { status: 500 }
      );
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin');
    const { id } = await params;

    const existing = await loadOwnedNonDefaultAgent(supabase, accountId, id);
    if (!existing)
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 });

    // FK actions do the rest: ai_router_members.agent_id cascades (a
    // router loses this one member, keeps the others), and any
    // ai_routers.fallback_agent_id pointing here sets to NULL — a
    // router referencing a deleted fallback just falls through to the
    // account's default agent (resolveAgentViaRouter), not an error.
    const { error } = await supabase.from('ai_configs').delete().eq('id', id);
    if (error) {
      console.error('[ai/agents DELETE] error:', error);
      return NextResponse.json(
        { error: 'Failed to delete agent' },
        { status: 500 }
      );
    }

    void audit({
      accountId,
      actorUserId: userId,
      action: 'ai_agent.deleted',
      resourceType: 'ai_config',
      resourceId: id,
      metadata: { name: existing.name },
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
