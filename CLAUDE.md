# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

## Commands

```bash
npm run dev          # next dev
npm run build        # next build — output: "standalone"
npm run lint         # eslint (flat config, eslint-config-next)
npm run typecheck    # tsc --noEmit
npm test             # vitest run
npm run test:watch
npm run format       # prettier --write .
```

CI (`.github/workflows/ci.yml`) runs lint → typecheck → test → build, in that
order, on every PR. Run `npm run typecheck` and `npm run format` before
proposing a change.

Single test file / single test:

```bash
npx vitest run src/lib/flows/engine.test.ts
npx vitest run -t "matchReplyId"
```

Tests are colocated (`foo.ts` + `foo.test.ts`) and run in the **node**
environment — there is no jsdom and no React Testing Library. Only pure logic
is unit-tested; the engines deliberately extract pure helpers (see the "Pure
helpers" section headers in `src/lib/flows/engine.ts`) so they can be exercised
without mocking Supabase or Meta. `vitest.config.ts` injects dummy
`ENCRYPTION_KEY` / `META_APP_SECRET` because `lib/whatsapp/*` reads them at
module load; keep those values identical to the ones in `ci.yml`.

Migrations have their own workflow: it boots a throwaway Postgres, replays
`supabase/migrations/` from nothing, then asserts the result against
`supabase/ci/verify-schema.sql`. Reproduce locally with the Supabase CLI
(`supabase db reset --local --no-seed`). Every DDL statement is
`IF NOT EXISTS`-guarded, so a typo'd object name is a silent no-op — when you
add a migration, extend `verify-schema.sql` too.

## What this is

A **template repository**, not a collaborative product (see CONTRIBUTING.md).
The expected flow is fork → deploy → customise; upstream keeps scope
deliberately narrow, and divergence in a fork is the point.

## Architecture

### Stack, and the shape it implies

Next.js 16 App Router + React 19 + Supabase (Postgres, Auth, Storage, Realtime)
+ Tailwind v4 + shadcn-style components over `@base-ui/react`. No ORM, no
server actions, no data-fetching library.

**Every page under `src/app/(dashboard)/` is a `"use client"` component that
queries Supabase directly from the browser.** There is no server-component data
layer. This is the most load-bearing fact in the repo: *authorization is
Postgres RLS*, not application code. A dashboard page that needs data calls
`createClient()` from `@/lib/supabase/client` and issues the query; RLS decides
what comes back.

`src/app/api/**` exists only for what the browser must not do:

- calls that need the Meta Graph API and a decrypted access token,
- calls that need the service-role key (webhook, engines, cron),
- privileged account operations that run through SECURITY DEFINER RPCs.

### Three auth paths, three clients

| Caller | Client | Scoping |
|---|---|---|
| Browser / dashboard | `@/lib/supabase/client` (singleton `createBrowserClient`) | RLS via the user's session |
| API route, human | `@/lib/supabase/server` via `getCurrentAccount()` / `requireRole(min)` in `@/lib/auth/account` | RLS via SSR cookies |
| API route, machine (`/api/v1`) | service role via `requireApiKey(req, scope)` in `@/lib/auth/api-context` | **manual** `.eq("account_id", ctx.accountId)` on every query |
| Engines / webhook / cron | `supabaseAdmin()` | **manual** — RLS bypassed |

Anywhere you use `supabaseAdmin()` you own tenancy yourself: filter by
`account_id`, and verify caller-supplied ids belong to the account before
touching them (`runAutomationsForTrigger` does exactly this for `contactId` —
follow that pattern).

The browser singleton in `lib/supabase/client.ts` is deliberate: multiple
browser clients cause auth-lock contention. Don't construct ad-hoc ones.

### Tenancy: accounts, not users

Migration `017_account_sharing.sql` moved the tenancy key from `user_id` to
`account_id` across the schema. Every table is account-scoped; `profiles` maps
`user_id → (account_id, account_role)`.

Roles are `owner > admin > agent > viewer`. `@/lib/auth/roles.ts` is the single
source of truth and mirrors the SQL helper `is_account_member(account_id,
min_role)` — the same ordinal ranking exists on both sides. **Never open-code a
role-string comparison.** Call the capability predicates (`canManageMembers`,
`canEditSettings`, `canSendMessages`, …) from both API guards and UI gates
(`useCan`, `RequireRole`, `GatedButton`); adding a capability should be one new
predicate plus its call sites.

Privileged mutations RLS can't express (invitation redemption, role changes,
member removal, ownership transfer) live as SECURITY DEFINER RPCs in migrations
018–020, not as route logic.

### The WhatsApp webhook is the system's front door

`src/app/api/whatsapp/webhook/route.ts` (~1200 lines) is the busiest file here.
One inbound message:

1. HMAC-SHA256 signature verified against `META_APP_SECRET`.
2. `metadata.phone_number_id` → `whatsapp_config` row → **that is how the
   account is resolved.** One WhatsApp number belongs to exactly one account
   (unique index, migration 013).
3. Contact resolved/deduped (`lib/contacts/dedupe`), conversation
   resolved/reopened, message persisted, media mirrored to Storage.
4. Fan-out inside `after()` so the 200 returns to Meta immediately: Flows
   engine → automations engine → AI auto-reply → outbound webhooks.

The Flows engine reports back whether it consumed the message, so the webhook
knows whether to also fire automations. Meta retries aggressively — every
consumer must be idempotent on `meta_message_id`.

### Automations vs Flows — two separate systems

Both are "no-code automation" and they are **not** the same thing.

- **Automations** (`src/lib/automations/`, migration 006): trigger → linear step
  list with conditional branches. Triggers on inbound message, new contact,
  keyword, tag added, interactive reply, or schedule. Long waits are durable — a
  `Wait` step parks a row in `automation_pending_executions`, drained by
  `GET /api/automations/cron` (shared secret in `x-cron-secret`, compared with
  `timingSafeEqual`). Fire-and-forget: `runAutomationsForTrigger` must never
  throw.
- **Flows** (`src/lib/flows/`, migration 010): a stateful per-contact
  conversation graph edited with `@xyflow/react`. Nodes are rows; edges live
  *inside* node config as `next_node_key` — a stable string key, not a UUID, so
  flows can be cloned and templated. A run suspends at nodes that need customer
  input and wakes on the next reply. Concurrency is handled at the DB layer:
  idempotency on `meta_message_id`, optimistic UPDATE gated on
  `current_node_key`, and a partial unique index enforcing one active run per
  contact.

`lib/flows/validate.ts` and `lib/automations/validate.ts` catch orphan and
missing edges at save time — the DB schema doesn't model them.

### AI assistant is bring-your-own-key

There is no global provider env var. Each account pastes its own OpenAI or
Anthropic key in Settings; it is stored AES-256-GCM-encrypted under
`ENCRYPTION_KEY`. `src/lib/ai/providers/` holds two thin adapters behind a
shared interface. The knowledge base uses hybrid retrieval: Postgres FTS
(`match_ai_knowledge_fts`) always, pgvector semantic search
(`match_ai_knowledge_semantic`) when an embeddings key is set. Auto-reply claims
a slot via `claim_ai_reply_slot` (migration 031) so concurrent webhooks can't
double-reply, and hands off to a human on the rules in `lib/ai/handoff.ts`.

### Public API and MCP

`/api/v1` is versioned and stable: bearer keys (`wacrm_live_…`, SHA-256 hashed
at rest), per-scope authorization (`lib/api-keys/scopes.ts`), a fixed-window
in-memory rate limiter, and a uniform envelope via `lib/api/v1/respond.ts`. The
limiter's Map lives in one Node process — horizontal scale silently defeats it
(documented at the top of `lib/rate-limit.ts`).

`mcp-server/` is a **separate npm package** (`wacrm-mcp`, its own
`package.json` / `tsconfig.json`, built with `tsc`) and a thin client over
`/api/v1` — no business logic, no DB access. Writes are opt-in behind
`WACRM_ENABLE_WRITES` / `WACRM_ENABLE_BROADCASTS`.

Outbound webhooks (`lib/webhooks/`) are HMAC-signed and SSRF-guarded —
`ssrf.ts` blocks private ranges. Reuse `isDeliverableUrl` for any new
user-supplied URL the server will fetch.

## Conventions worth knowing

- Path alias `@/*` → `src/*`.
- `ENCRYPTION_KEY` is 64 hex chars (AES-256-GCM), used for WhatsApp tokens and
  AI provider keys. Rotating it orphans every ciphertext — there is no
  re-encryption path.
- i18n is **build-time single-locale**, not per-request: `src/i18n/request.ts`
  reads `NEXT_PUBLIC_APP_LOCALE` and falls back to `en`. There is no locale
  segment in the URL. Dictionaries live in `messages/`; `src/i18n/*.test.ts`
  asserts key parity and ICU safety, so adding a string to `en.json` without the
  other locales fails CI.
- Theming: accent (`data-theme`) and mode (`data-mode`) are applied by an inline
  boot script in `src/app/layout.tsx` before hydration to avoid a flash. Valid
  ids come from `src/lib/themes.ts` — add them there, not in the script string.
- CSP ships as `Content-Security-Policy-Report-Only` in `next.config.ts`; the
  header comment explains the path to enforcing it. The `Cache-Control` rules in
  the same file exist to fix a specific CDN chunk-hash-drift failure — read the
  comment before touching them.
- The codebase comments *why*, usually citing the issue number that motivated a
  defensive branch. Several branches look like removable noise and are not
  (`getCurrentAccount`'s point lookup instead of an FK embed, the middleware's
  cookie-copying helper). Read the comment before simplifying.
- Formatting is mixed — some files use single quotes and no semicolons, others
  Prettier's defaults. Match the file you're in; `npm run format` is the arbiter.
- Commit style: imperative, terse first line; the body explains the *why*.
