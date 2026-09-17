# Spec: Add Gemini as a third AI provider

**Status: implemented.** `src/lib/ai/providers/gemini.ts`, `AiProvider`
widened in `types.ts`, dispatch added in `generate.ts`, Settings UI radio +
model default, migration `050_ai_provider_gemini.sql` widening the
`ai_configs`/`ai_usage_log` CHECK constraints (applied), i18n updated in all
four locales. Verified live in Settings > Agentes de IA > Configuração:
selecting "Google Gemini" swaps the model default to `gemini-2.5-flash` and
the key placeholder to `AIza...`.

## Problem

The bring-your-own-key AI assistant (`src/lib/ai/`) only supports OpenAI
and Anthropic. Accounts that already pay for Google AI Studio / Vertex
Gemini can't use their existing key and have to buy a second one just
to turn on auto-reply / the knowledge-base assistant.

## Non-goals

- Vertex AI's enterprise auth (service accounts, GCP project billing).
  This targets the simple Google AI Studio API key flow, matching how
  OpenAI/Anthropic keys work today (paste a key, done).
- Changing the provider selection UX beyond adding a third radio
  option — no per-conversation provider switching.
- Embeddings for the knowledge base's semantic search
  (`match_ai_knowledge_semantic`) — this spec is chat-completion only;
  a Gemini embeddings adapter is a separate follow-up if the account
  wants Gemini for both.

## Current behavior

- `src/lib/ai/types.ts:9` — `export type AiProvider = 'openai' | 'anthropic'`.
- `src/lib/ai/providers/openai.ts` and `anthropic.ts` each implement
  the same shape: take `ProviderArgs` (`apiKey`, `model`, `systemPrompt`,
  `messages`, `timeoutMs`) from `src/lib/ai/providers/shared.ts`, call
  the provider's chat-completions endpoint, normalize the response into
  `{ text, usage }` via `normalizeUsage()`, and map network/timeout
  failures to a typed `AiError` via `toNetworkError()`.
- `src/lib/ai/generate.ts` dispatches on `config.provider` with a
  `switch` (line ~38) to call the right adapter.
- `src/lib/ai/config.ts` — `AiConfig.provider: 'openai' | 'anthropic'`,
  loaded from the account's encrypted key (`ENCRYPTION_KEY`,
  AES-256-GCM, per `CLAUDE.md`'s "AI assistant is bring-your-own-key"
  section).
- `src/components/settings/ai-config.tsx` — the Settings > AI panel;
  `provider` state defaults to `'openai'`, radio-selects between the
  two, has provider-specific copy (e.g. `sameKeyText` at line 376 is
  OpenAI-only messaging that would need a Gemini equivalent or a more
  generic phrasing).

## Proposed change

1. Add `src/lib/ai/providers/gemini.ts` implementing the same
   `ProviderArgs -> { text, usage }` contract as `openai.ts`/`anthropic.ts`,
   calling Google's `generateContent` REST endpoint
   (`https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`)
   with the API key as a query param or `x-goog-api-key` header. Map
   Gemini's `usageMetadata.{promptTokenCount,candidatesTokenCount,totalTokenCount}`
   into `normalizeUsage()`'s expected shape.
2. `src/lib/ai/types.ts`: widen `AiProvider` to
   `'openai' | 'anthropic' | 'gemini'`.
3. `src/lib/ai/generate.ts`: add a `case 'gemini':` branch.
4. `src/components/settings/ai-config.tsx`: add the third radio option,
   a Gemini model picker (e.g. `gemini-2.0-flash`, `gemini-2.5-pro` —
   confirm current model ids at implementation time, Google renames
   these often), and generalize `sameKeyText`-style copy that's
   currently OpenAI-specific.
5. `messages/*.json`: any new/changed strings, all four locales —
   `src/i18n/*.test.ts` enforces parity.
6. No migration needed — `ai_configs.provider` is presumably a plain
   TEXT column (confirm), so a new value doesn't need a schema change,
   only app-level validation wherever `provider` is checked against an
   allowlist.

## Acceptance criteria

- [ ] An account can paste a Google AI Studio key, pick a Gemini model,
      and the knowledge-base assistant / auto-reply replies using it.
- [ ] A malformed/revoked Gemini key surfaces the same class of error
      UI the other two providers already show (not a raw stack trace).
- [ ] `npm test` — provider adapter gets the same test coverage shape
      as the existing two (check for `providers/openai.test.ts` or
      similar and mirror it for Gemini if it exists).
- [ ] All four `messages/*.json` stay in parity.

## Risks / open questions

- Confirm the DB column backing `provider` (migration that added
  `ai_configs`) is unconstrained TEXT, not a Postgres ENUM/CHECK that
  would need its own migration to add `'gemini'`.
- Gemini's safety-filter response shape differs from OpenAI/Anthropic's
  refusal format — decide how a safety-blocked response surfaces to the
  end customer vs. how OpenAI/Anthropic refusals do today.
- Rate limits and pricing differ meaningfully from the other two —
  worth a short callout in the Settings UI copy, not just the model
  picker.
