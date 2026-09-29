# Spec: Manageable AI agents (edit page, model picker, per-agent usage)

> Ported in spirit from deskcomm's agents UI
> (`docs/specs/12-spec-ai-agents-ui.md`, `app/app/ai/agents/*`: agents
> list, per-agent tabs *Configuração / Testar / Execuções / Histórico*,
> `ModelPicker`, credential validation "Validada · 8 modelos
> disponíveis"). wacrm already has the multi-agent **backend**
> (`specs/multi-agent-router.md`, migration 066); this spec is about the
> missing management **surface**. The user's words: deskcomm's agents are
> "bem mais gerenciáveis" and "trazem as listagens dos modelos de cada
> agente".

## Problem

After migration 066 an account can have several AI agents, but they are
barely manageable:

1. **A non-default agent can be created and deleted, never edited.** The
   list (`src/components/agents/ai-agents-list.tsx`) offers "add" (name,
   provider, model, API key) and "delete", nothing else — no way to change
   its prompt, model, cap, handoff assignee or on/off in the UI. The
   **API can**: `PATCH /api/ai/agents/[id]` accepts `name`,
   `system_prompt`, `is_active`, `auto_reply_enabled`,
   `auto_reply_max_per_conversation`, `handoff_agent_id`, and
   provider/model/key. The only prompt editor in the UI is Settings → AI
   Assistant, which edits the **default** agent. So a second agent is
   effectively frozen at whatever prompt it was created with (it is
   created with none).
2. **The model is a free-text box.** Users must know that
   `claude-sonnet-4-5` or `gemini-2.5-flash` are valid ids for their
   provider and key; a typo is found only when a customer message fails.
   (`POST /api/ai/test` can validate one candidate after the fact.) There
   is no list of what the key can actually use, and no warning that some
   models can't do tool calls — which the agenda agent needs
   (`AGENDA_TOOLS`). The OpenRouter default is the "Free Models Router"
   (`src/lib/ai/defaults.ts:13`), whose randomly chosen free model often
   lacks tool support.
3. **No per-agent visibility.** `ai_usage_log` (migration 033) has no
   agent column, so usage can only be seen account-wide
   (`src/components/agents/ai-usage.tsx`). With several agents nobody can
   answer "which agent is spending the tokens / answering how much?".
4. **No safe way to change a live agent.** Editing a prompt on an agent
   that is answering customers takes effect immediately with no history, no
   diff, no rollback.
5. **Handoff only happens when the model decides to.** A customer typing
   "quero falar com um atendente" reaches the model like any other text;
   there is no deterministic keyword path (deskcomm has "Palavras-chave de
   handoff direto — bypassa o LLM"). Ties into
   `specs/handoff-customer-notice.md` (reason `customer_requested_human`).

## Non-goals

- **Draft/publish workflow with scheduled publishing.** Phase 2 adds
  *history and restore*, not a staging environment.
- **Per-agent knowledge bases** (already a stated non-goal of
  `multi-agent-router.md`; the base stays account-shared).
- **Tool-call traces / run replay** (deskcomm's `RunTrace`). wacrm doesn't
  persist tool-call steps; building that is a separate observability spec.
- **A tool marketplace / arbitrary MCP tools per agent.** Capabilities stay
  the built-in sets (contact, agenda, later cases).
- **Automatic model selection or A/B testing.**
- **Rewriting the routing/classification logic** (`router.ts`).

## Current behavior

- Schema: `ai_configs` is one row **per agent** (`is_default`, `name` from
  migration 066); provider/model/encrypted key/prompt/cap/handoff
  assignee/`fallbacks` live on it. Routers + members bind agents to
  intents (`ai_routers`, `ai_router_members`).
- API: `GET/POST /api/ai/agents`, `GET/PATCH/DELETE /api/ai/agents/[id]`
  (**non-default only** — `loadOwnedNonDefaultAgent`), `POST /api/ai/test`
  (validate key+model without saving), `POST /api/ai/playground`,
  `GET /api/ai/usage`, `/api/ai/routers*`.
- UI: `src/components/agents/{ai-multi-agent,ai-agents-list,ai-routers,
  ai-playground,ai-usage}.tsx`; default agent in
  `src/components/settings/ai-config.tsx`.
- `ai_usage_log(account_id, conversation_id, mode, provider, model,
  prompt/completion/total_tokens, created_at)` — no `agent_id`, admin+
  read only (spend is billing-class).
- Model default per provider: `AI_PROVIDER_DEFAULT_MODEL`
  (`defaults.ts:13`). Providers: `openai | anthropic | gemini |
  openrouter` (`src/lib/ai/providers/*`).
- deskcomm reference: agent card = status badge + version + model + last
  run + runs/cost today; detail page with tabs; `ModelPicker` showing
  window and price per 1M tokens; credential picker showing validation
  and model count; version history with diff and publish confirmation.

## Proposed change

### 1. Model picker fed by the provider (the "listagem dos modelos")

`POST /api/ai/models` (admin+; POST so a candidate key never travels in a
query string): body `{ provider, api_key?, agent_id? }` — blank key uses
the agent's stored (decrypted) key, same fallback rule as `/api/ai/test`.
It calls the provider's model-list endpoint, **normalizes** the result and
returns:

```ts
type ModelOption = {
  id: string;                 // what gets stored in ai_configs.model
  label: string;
  contextWindow?: number;
  inputPerMTok?: number;      // USD, only when the provider supplies it
  outputPerMTok?: number;
  supportsTools?: boolean;    // only when known
};
```

Per provider (confirm exact fields at implementation time — these APIs
evolve):

- **Anthropic** — models endpoint (`id`, `display_name`); all current
  chat models support tools.
- **Gemini** — `models.list`, keep entries whose
  `supportedGenerationMethods` include `generateContent`; provides
  `inputTokenLimit`/`outputTokenLimit`.
- **OpenAI** — `GET /v1/models` returns *everything* (embeddings, whisper,
  tts, moderation…); filter with an allow-pattern for chat families and an
  exclude list, and treat the result as "best effort".
- **OpenRouter** — public list with `context_length`, per-token pricing,
  and `supported_parameters` (contains `tools` when tool calls work) — the
  richest source, and the only one that lets us warn about the free router.

Rules: results cached ~10 minutes in memory keyed by `(accountId,
provider, sha256(key))` — never the key; 8 s timeout; the response never
echoes the key; provider errors map to a short code + message
(`invalid_key`, `rate_limited`, `unreachable`). **Never invent data:** a
price or window the provider didn't supply is simply not shown, and there
is no hard-coded price table (it goes stale silently). If listing fails
the picker falls back to the current default id plus a **"Outro (digitar o
id)"** field, so a provider hiccup can't block saving.

UI: a searchable combobox (id, label, window, `$/1M` when known, a
"sem suporte a ferramentas" badge). If the agent has agenda tools on and
the chosen model is known **not** to support tools, show a blocking
warning on save ("este modelo não consegue agendar"). A "Validada · N
modelos" line under the key field reuses `/api/ai/test`. The existing
new-agent dialog uses the same picker.

### 2. Agent detail page — make agents editable

`/agents/[id]` (admin+ edit, agent+ read), reached from the list. Tabs:

- **Configuração** — name, description, on/off (`is_active`), auto-reply
  toggle, **system prompt** (large textarea with a live token estimate),
  model picker + key, reply cap (`auto_reply_max_per_conversation`),
  handoff assignee (`handoff_agent_id`), handoff keywords (§4). Saves via
  the **existing** `PATCH /api/ai/agents/[id]`; new fields extend it.
- **Testar** — the existing playground (`/api/ai/playground`) bound to
  *this* agent's config (confirm it can target a non-default agent; extend
  if not), so a prompt can be tried before customers see it.
- **Uso** — per-agent tokens/replies over 7/30 days, last reply time, and
  recent rows linking to the conversation (§3).
- **Histórico** — phase 2.

The list card gains: status badge (*Ativo · Pausado · Incompleto — sem
chave/modelo*), provider + model, replies and tokens for the last 7 days,
last reply "há 2 min", and which routers/intents point at it. Default agent
card links to Settings → AI Assistant until phase 3 unifies the editors.

### 3. Per-agent usage

```sql
ALTER TABLE ai_usage_log
  ADD COLUMN IF NOT EXISTS agent_id uuid
    REFERENCES ai_configs(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_ai_usage_log_agent_created
  ON ai_usage_log (agent_id, created_at DESC);
```

`logAiUsage()` (called from `auto-reply.ts:354` and the draft route)
records the agent whose config produced the reply — the router already
resolves it (`resolveAgentViaRouter`). Old rows keep `agent_id NULL`
("agente anterior"). `GET /api/ai/usage` gains `?agent_id=` and a group-by
agent. Cost display only where a price is *known* (OpenRouter-supplied, or
phase 2's optional per-model price the admin enters); otherwise tokens
only. RLS unchanged (admin+).

### 4. Deterministic "chame um humano" keywords (small, high value)

`ai_configs.handoff_keywords text[] NOT NULL DEFAULT '{}'`. A pure matcher
(accent/case-insensitive, whole-phrase, pt/en/es defaults like
"atendente", "falar com humano", "pessoa real") runs in
`dispatchInboundToAiReply` **before** any model call: on a hit, hand off
immediately with reason `customer_requested_human` — no tokens spent, no
model discretion, and the customer gets the notice from
`handoff-customer-notice.md`. Off unless keywords are configured; the UI
offers "Usar sugestões" so it isn't an empty box. Precedent for the
matcher: `isOptOutMessage`.

### 5. Phase 2 — history and restore

```sql
CREATE TABLE IF NOT EXISTS ai_config_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  config_id uuid NOT NULL REFERENCES ai_configs(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  version int NOT NULL,
  snapshot jsonb NOT NULL,   -- prompt, model, provider, cap, keywords…
                             -- NEVER the API key
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (config_id, version)
);
```

Written on each `PATCH` that changes a versioned field; a history tab lists
versions with a **field-level diff** and "Restaurar esta versão" (which
itself writes a new version, never rewrites history). Cap at the last N
(e.g. 50). Also `audit()` entries `ai_agent.updated` (specs/
audit-log-endurecido) so *who changed the prompt* is answerable.

### 6. Phase 3 — one editor

Fold Settings → AI Assistant's default-agent form into the same detail
page (redirect), leaving account-wide items (knowledge base, embeddings
key, the fallback-provider chain, global cap) in Settings. Removes the
"two places to edit an agent" confusion introduced by 066.

## Acceptance criteria

- [ ] A non-default agent's prompt, model, cap, on/off and handoff
      assignee can be edited from the UI, and the change is what the next
      auto-reply uses.
- [ ] With a valid key the model picker lists that key's usable models;
      with an invalid key it shows the provider's reason and still lets
      the user type an id.
- [ ] No response, log line, cache key or error ever contains the API key
      (test asserts the serialized output of `/api/ai/models`).
- [ ] Choosing a model known not to support tool calls, on an agent with
      agenda tools enabled, is blocked with an explanation.
- [ ] Prices/windows are shown only when the provider supplied them.
- [ ] After a reply, `ai_usage_log.agent_id` is the agent that answered;
      the Uso tab and list card show that agent's numbers; pre-existing
      rows show as "agente anterior".
- [ ] A message containing a configured handoff keyword hands off with
      reason `customer_requested_human`, spends **no** tokens, and the
      customer is notified.
- [ ] (Phase 2) Editing the prompt creates a version; restoring one
      creates a new version and takes effect; no version snapshot contains
      a key.
- [ ] Viewers can read agents but not edit; `agent_id` filtering can't
      reveal another account's usage (RLS + explicit `account_id` filter).
- [ ] `verify-schema.sql` asserts the new column/index/table; all four
      locales updated; unit tests for the model normalizers (fixture
      responses per provider), the OpenAI chat-model filter, and the
      keyword matcher.

## Risks / open questions

- **Provider list endpoints change and differ.** The normalizers are the
  fragile part; fixtures + a "lista indisponível" fallback keep them from
  ever blocking a save. Verify each endpoint's current shape at
  implementation time.
- **OpenAI's list is noisy.** The chat-model filter is a heuristic and will
  occasionally hide a valid new model or show an unusable one — hence the
  always-available "digitar o id" escape.
- **Tool-support knowledge is partial.** Only OpenRouter states it per
  model; for others we assume chat models support tools. A wrong warning
  is worse than none — only warn when *known*.
- **Cost honesty.** Showing a computed dollar cost from a stale price would
  be misleading; the spec prefers "tokens only" over a guess.
- **Prompt editing power.** Enabling non-default agent editing hands
  admins a way to break a live agent in one click; that is what phase 2's
  history and the Testar tab exist to mitigate — consider shipping Testar
  in the same release as the edit form.
- **Who sees usage.** `ai_usage_log` is admin+ by design (billing-class).
  The per-agent "replies today / last reply" on the list card needs counts
  that don't reveal spend — derive them from `conversations`/`messages`
  (`ai_generated`) or expose a counts-only RPC rather than loosening that
  RLS.

## Implementation notes (2026-09-29)

**Decision recorded (user): agent management is per NUMBER and per CLIENT.**
The product owner will operate micro-businesses (a barbershop, a clinic), so
"which agent answers where" cannot be an account-wide setting only.

- *Per client* is the account boundary that already exists: each client is an
  account with its own agents, keys and usage (operator mode is
  `operator-multi-account.md`).
- *Per number* is new: `ai_channel_agents` (migration 074) binds one agent to
  one number (`channel_id NULL` = the Cloud API number). Resolution order in
  `dispatchInboundToAiReply`: **active router → agent bound to the number →
  default agent**. A bound agent that is off / has no key / cannot be loaded
  makes the AI **stay silent on that number** rather than fall back to the
  default agent (answering one client's customers with another persona is
  worse than not answering). Enforced in Postgres: a trigger refuses an agent
  or channel from another account.

Built (phase 1): model picker fed by the provider (`POST /api/ai/models`,
per-provider normalizers, 10-min cache keyed by hash, key never echoed,
"type the id" always available); `/agents/[id]` edit page (config, numbers,
30-day usage); per-agent usage (`ai_usage_log.agent_id`, `?agent_id=` and
`by_agent` on `/api/ai/usage`); deterministic handoff phrases (default agent
in Settings → AI, others on the edit page), reason
`customer_requested_human`, no tokens spent.

Deviations / not built yet:

- **OpenRouter is listed without sending the key** (the catalogue is public):
  a wrong or unreadable stored key must not hide the list.
- The "blocking warning when the model is known to lack tools" is shown as an
  inline warning, not a save blocker: non-default agents have no agenda tools
  today, so there is nothing for it to break yet.
- **Testar tab** (playground bound to this agent) — the playground still
  targets the default agent.
- Phase 2 (history / restore) and phase 3 (one editor for the default agent)
  — not started. The default agent is still edited under Settings → AI; the
  edit page and the numbers card are for non-default agents (a number with no
  binding is the default agent's by definition).
- Per-agent card details on the list (replies/tokens 7d, last reply, routers
  pointing at it) and a per-agent table on the Uso tab — the API returns
  `by_agent`, the UI does not use it yet.
- Handoff keywords have no per-language defaults beyond the "use suggestions"
  starter list (pt/en/es).
