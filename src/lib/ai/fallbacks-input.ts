import { decrypt } from '@/lib/whatsapp/encryption';
import type { AiProvider, AiProviderCredentials } from './types';

// Shared by /api/ai/config (default agent) and /api/ai/agents/[id].

/** Cap on configured fallback tiers — a couple covers the real failure
 *  modes (provider outage, provider quota) without turning AI config
 *  into an open-ended rules engine. See specs/ai-provider-fallback-chain.md. */
export const MAX_FALLBACK_TIERS = 2;

export const VALID_PROVIDERS: AiProvider[] = [
  'openai',
  'anthropic',
  'gemini',
  'openrouter',
];

export interface RawFallbackInput {
  provider?: unknown;
  model?: unknown;
  api_key?: unknown;
}

/**
 * Parse + validate the `fallbacks` array from the request body against
 * whatever fallback tiers are already stored (so a save that doesn't
 * touch a tier's key doesn't require re-entering it). Returns `null` on
 * a validation failure, with the reason in `error`.
 */
export async function resolveFallbacks(
  raw: unknown,
  existing: { provider: string; model: string; api_key: string }[]
): Promise<{ tiers: AiProviderCredentials[] } | { error: string }> {
  if (raw === undefined) {
    // Field omitted entirely → leave the stored fallbacks unchanged.
    const tiers: AiProviderCredentials[] = [];
    for (const tier of existing) {
      try {
        tiers.push({
          provider: tier.provider as AiProvider,
          model: tier.model,
          apiKey: decrypt(tier.api_key),
        });
      } catch {
        return {
          error: 'A stored fallback key could not be decrypted — re-enter it.',
        };
      }
    }
    return { tiers };
  }

  if (!Array.isArray(raw)) return { error: 'fallbacks must be an array' };
  if (raw.length > MAX_FALLBACK_TIERS) {
    return { error: `fallbacks supports at most ${MAX_FALLBACK_TIERS} tiers` };
  }

  const tiers: AiProviderCredentials[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i] as RawFallbackInput;
    const provider = item?.provider as AiProvider;
    if (!VALID_PROVIDERS.includes(provider)) {
      return {
        error: `fallbacks[${i}].provider must be "openai", "anthropic", or "gemini"`,
      };
    }
    const model = typeof item?.model === 'string' ? item.model.trim() : '';
    if (!model) return { error: `fallbacks[${i}].model is required` };

    const rawKey = typeof item?.api_key === 'string' ? item.api_key.trim() : '';
    if (rawKey) {
      tiers.push({ provider, model, apiKey: rawKey });
      continue;
    }
    // No key sent for this tier — reuse the stored one at the same
    // position if the provider/model still match; otherwise a key is
    // required (can't validate/save a tier with no key at all).
    const prior = existing[i];
    if (prior && prior.provider === provider && prior.model === model) {
      try {
        tiers.push({ provider, model, apiKey: decrypt(prior.api_key) });
        continue;
      } catch {
        return {
          error: `fallbacks[${i}]: stored key could not be decrypted — re-enter it.`,
        };
      }
    }
    return { error: `fallbacks[${i}].api_key is required` };
  }
  return { tiers };
}
