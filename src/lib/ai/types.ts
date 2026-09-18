// ============================================================
// Shared types for the AI reply assistant (bring-your-own-key).
//
// One small provider-agnostic surface so the inbox draft route and the
// inbound auto-reply bot both talk to `generateReply` without caring
// whether the account is on OpenAI or Anthropic.
// ============================================================

export type AiProvider = 'openai' | 'anthropic' | 'gemini'

/** A provider/model/key triple — the primary config and each fallback
 *  tier share this shape (see `AiConfig.fallbacks`). */
export interface AiProviderCredentials {
  provider: AiProvider
  model: string
  apiKey: string
}

/**
 * Account AI setup, decrypted and ready to use. Produced by
 * `loadAiConfig` — `apiKey` is the plaintext BYO provider key
 * (stored AES-256-GCM-encrypted at rest).
 */
export interface AiConfig {
  provider: AiProvider
  model: string
  apiKey: string
  systemPrompt: string | null
  isActive: boolean
  autoReplyEnabled: boolean
  autoReplyMaxPerConversation: number
  /** Where auto-reply hands a conversation off when the model bails: an
   *  agent's `auth.users.id`, or null to leave it unassigned (drop into
   *  the shared queue). */
  handoffAgentId: string | null
  /** Optional OpenAI-compatible key for embeddings. When set, the
   *  knowledge base is embedded and semantic retrieval turns on; when
   *  null, retrieval falls back to lexical full-text search. */
  embeddingsApiKey: string | null
  /** Ordered fallback tiers tried, in order, when the primary
   *  provider/model fails (see `generateReplyWithFallback`). Empty
   *  when the account hasn't configured any — the auto-reply bot then
   *  behaves exactly as it did before fallbacks existed: one attempt,
   *  then a handoff on failure. */
  fallbacks: AiProviderCredentials[]
}

/** A single conversation turn in the shape both providers accept. */
export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

/**
 * Token counts for one provider call, normalized across OpenAI
 * (`prompt`/`completion`) and Anthropic (`input`/`output`). Null when
 * the provider didn't return usage. Logged to `ai_usage_log`.
 */
export interface AiUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

/** Raw text + usage a provider adapter returns before handoff parsing. */
export interface ProviderResult {
  text: string
  usage: AiUsage | null
}

/** Outcome of a generation call. */
export interface GenerateResult {
  /** The reply text, with any handoff sentinel and multi-message
   *  delimiters stripped — `segments.join('\n\n')`. Callers that send
   *  one message (draft, playground) use this; auto-reply sends
   *  `segments` instead so a multi-idea reply arrives as separate
   *  WhatsApp bubbles. */
  text: string
  /** The reply split on `MULTI_MESSAGE_DELIMITER` (auto-reply mode
   *  only — draft/playground never instruct the model to emit it, so
   *  this is almost always `[text]` there). Always has at least one
   *  entry when `text` is non-empty; empty when the model bailed to a
   *  handoff with no text. */
  segments: string[]
  /** True when the model asked to hand off to a human (auto-reply mode). */
  handoff: boolean
  /** Provider token usage for this call, or null when unavailable. */
  usage: AiUsage | null
}

/**
 * Typed error for every AI failure mode. `status` maps cleanly to an
 * HTTP response in the draft route; `code` lets the UI/tests branch
 * (invalid_key vs rate_limited vs timeout, etc.).
 */
export class AiError extends Error {
  readonly code: string
  readonly status: number
  constructor(message: string, opts: { code?: string; status?: number } = {}) {
    super(message)
    this.name = 'AiError'
    this.code = opts.code ?? 'ai_error'
    this.status = opts.status ?? 502
  }
}
