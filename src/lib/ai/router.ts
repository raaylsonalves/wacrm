import type { SupabaseClient } from '@supabase/supabase-js';

import { loadAiConfig } from './config';
import { generateReply } from './generate';
import type { AiConfig, AiUsage } from './types';
import { logAiUsage } from './usage';
import { primaryConfigId } from '@/lib/whatsapp/conversation-number';

interface RouterRow {
  id: string;
  account_id: string;
  channel_id: string | null;
  /** Scoped to one official number (migration 121). */
  whatsapp_config_id: string | null;
  classifier_model: string | null;
  min_confidence: number;
  sticky: boolean;
  fallback_agent_id: string | null;
}

interface RouterMemberRow {
  agent_id: string;
  intent_name: string;
  intent_description: string;
  examples: string[];
}

interface ActiveRouter {
  router: RouterRow;
  members: RouterMemberRow[];
}

/**
 * The account's active router for this conversation's number
 * (specs/multi-agent-router.md): the router scoped to that number — a
 * WAHA channel or an official number (migration 121) — wins over the
 * whole-account one. `idx_ai_routers_active_per_scope` keeps at most one
 * active router per scope.
 *
 * `skipWholeAccount`: the caller has an agent bound to this number, which
 * is a more specific instruction than a whole-account router — only a
 * router of the number itself replaces it.
 *
 * Returns `null` when there's no applicable active router OR it has no
 * intents configured yet — either way the caller falls straight back to
 * the bound / default agent.
 */
export async function loadActiveRouterForChannel(
  db: SupabaseClient,
  accountId: string,
  channelId: string | null,
  configIdArg: string | null = null,
  opts: { skipWholeAccount?: boolean } = {}
): Promise<ActiveRouter | null> {
  let configId = configIdArg;
  // Few routers per account: fetch the active ones and pick here.
  const { data: routers, error } = await db
    .from('ai_routers')
    .select(
      'id, account_id, channel_id, whatsapp_config_id, classifier_model, min_confidence, sticky, fallback_agent_id'
    )
    .eq('account_id', accountId)
    .eq('is_active', true);

  if (error || !routers || routers.length === 0) return null;

  const rows = routers as RouterRow[];
  // A conversation from before multi-number support has no number of its
  // own: it belongs to the primary, like everywhere else (A6).
  if (!channelId && !configId && rows.some((r) => r.whatsapp_config_id)) {
    configId = await primaryConfigId(db, accountId);
  }
  const own = rows.find(
    (r) =>
      (!!channelId && r.channel_id === channelId) ||
      (!channelId && !!configId && r.whatsapp_config_id === configId)
  );
  const wholeAccount = opts.skipWholeAccount
    ? undefined
    : rows.find((r) => !r.channel_id && !r.whatsapp_config_id);
  const router = own ?? wholeAccount;
  if (!router) return null;

  const { data: members } = await db
    .from('ai_router_members')
    .select('agent_id, intent_name, intent_description, examples')
    .eq('router_id', router.id)
    .order('position', { ascending: true });

  if (!members || members.length === 0) return null;

  return { router, members: members as RouterMemberRow[] };
}

interface ClassifyResult {
  intentName: string | null;
  confidence: number;
  /** What the classification call cost, to be logged (A10). */
  usage?: AiUsage | null;
}

/**
 * One short classification call against the account's own BYO key
 * (non-goal: a separate classification service) — `classifierConfig`
 * is either the router's own `classifier_model` layered onto the
 * default agent's provider/key, or the default agent's config
 * unchanged. Never throws: any failure (bad JSON, provider error,
 * timeout) resolves to "no match", which the caller treats as a miss
 * and falls back — a broken classifier must never block a reply.
 */
async function classifyIntent(
  classifierConfig: AiConfig,
  members: RouterMemberRow[],
  messageText: string
): Promise<ClassifyResult> {
  const intentList = members
    .map((m, i) => {
      const examples =
        m.examples.length > 0 ? ` Examples: ${m.examples.join(' | ')}` : '';
      return `${i + 1}. "${m.intent_name}" — ${m.intent_description}.${examples}`;
    })
    .join('\n');

  const systemPrompt =
    'You classify a single customer message into exactly one of the intents below, ' +
    'or "none" if nothing fits. Reply with ONLY a JSON object of the exact shape ' +
    '{"intent": "<name or none>", "confidence": <0 to 1>} — no other text.\n\n' +
    `Intents:\n${intentList}`;

  try {
    const result = await generateReply({
      config: classifierConfig,
      systemPrompt,
      messages: [{ role: 'user', content: messageText }],
      timeoutMs: 10_000,
    });
    const parsed = JSON.parse(result.text) as {
      intent?: unknown;
      confidence?: unknown;
    };
    const intentName = typeof parsed.intent === 'string' ? parsed.intent : null;
    const confidence =
      typeof parsed.confidence === 'number' ? parsed.confidence : 0;
    if (!intentName || intentName === 'none')
      return { intentName: null, confidence: 0, usage: result.usage };
    return { intentName, confidence, usage: result.usage };
  } catch (err) {
    console.warn('[ai router] classification failed, falling back:', err);
    return { intentName: null, confidence: 0 };
  }
}

interface ResolveArgs {
  db: SupabaseClient;
  accountId: string;
  conversationId: string;
  /** Already resolved default-agent config — doubles as the ultimate
   *  fallback when the router, its fallback agent, and the classifier
   *  all come up empty. */
  defaultConfig: AiConfig;
  activeRouter: ActiveRouter;
  /** null when the conversation isn't sticky-assigned yet. */
  currentAgentId: string | null;
  messageText: string;
}

/**
 * Resolves which agent should answer this turn, applying the router's
 * sticky/classify/fallback rules. Always returns a usable `AiConfig` —
 * on any failure along the way (classifier error, a referenced agent
 * deleted or deactivated) it degrades to `defaultConfig` rather than
 * throwing, per the spec's "erro no classificador nunca derruba o
 * turno" doctrine.
 */
export async function resolveAgentViaRouter(
  args: ResolveArgs
): Promise<AiConfig> {
  const {
    db,
    accountId,
    conversationId,
    defaultConfig,
    activeRouter,
    currentAgentId,
    messageText,
  } = args;
  const { router, members } = activeRouter;

  // Sticky: a conversation already assigned to an agent this session
  // keeps it — no reclassification per turn. Falls through to
  // classify if the assigned agent no longer resolves (deleted /
  // deactivated since), rather than silently stalling on a config
  // that doesn't exist.
  // An agent whose auto-reply is off never answers through the router —
  // the same rule the pinned and the number-bound agents follow (A4).
  const usable = async (agentId: string) => {
    const cfg = await loadAiConfig(db, accountId, { agentId });
    return cfg && cfg.autoReplyEnabled ? cfg : null;
  };

  // Only while that agent still belongs to this router (as a member or
  // its fallback): one removed from it stops answering old threads (A14).
  const inRouter = (id: string) =>
    id === router.fallback_agent_id || members.some((m) => m.agent_id === id);
  if (router.sticky && currentAgentId && inRouter(currentAgentId)) {
    const stuck = await usable(currentAgentId);
    if (stuck) return stuck;
  }

  const classifierConfig: AiConfig = router.classifier_model
    ? { ...defaultConfig, model: router.classifier_model }
    : defaultConfig;

  const { intentName, confidence, usage } = await classifyIntent(
    classifierConfig,
    members,
    messageText
  );
  // The classifier is a paid call on the account's key too.
  void logAiUsage(db, {
    accountId,
    conversationId,
    agentId: null,
    mode: 'auto_reply',
    provider: classifierConfig.provider,
    model: classifierConfig.model,
    usage: usage ?? null,
  });

  let resolvedAgentId: string | null = null;
  let resolvedConfig: AiConfig = defaultConfig;

  const matched = intentName
    ? members.find((m) => m.intent_name === intentName)
    : undefined;
  if (matched && confidence >= router.min_confidence) {
    const agentConfig = await usable(matched.agent_id);
    if (agentConfig) {
      resolvedAgentId = matched.agent_id;
      resolvedConfig = agentConfig;
    }
  }

  if (!resolvedAgentId && router.fallback_agent_id) {
    const fallbackConfig = await usable(router.fallback_agent_id);
    if (fallbackConfig) {
      resolvedAgentId = router.fallback_agent_id;
      resolvedConfig = fallbackConfig;
    }
  }

  // Sticky persistence: whatever this turn resolved to (classified
  // match, fallback agent, or the default) is what the rest of the
  // conversation gets, if sticky. Best-effort — a failed write just
  // means the next turn re-resolves, not a broken reply.
  if (router.sticky && (!currentAgentId || !inRouter(currentAgentId))) {
    const stickyId = resolvedAgentId ?? defaultConfig.id ?? null;
    if (stickyId) {
      await db
        .from('conversations')
        .update({ active_ai_agent_id: stickyId })
        .eq('id', conversationId)
        .eq('account_id', accountId);
    }
  }

  return resolvedConfig;
}
