# Spec: Surface MCP connectivity inside the app (not just docs)

## Problem

wacrm already lets AI assistants (Claude Desktop, Claude Code, Cursor,
…) connect and drive the CRM in natural language — it ships a full MCP
server (`mcp-server/`, published as `wacrm-mcp` on npm) that wraps the
public API. This isn't a missing feature; it's an **undiscovered** one.
There is no in-app UI that tells an account admin this exists or walks
them through enabling it — today it's `docs/mcp.md` only, which a
day-to-day user of the dashboard will never open.

## Non-goals

- Building a new MCP server or protocol support — `mcp-server/` already
  implements this correctly (thin wrapper over `/api/v1`, scoped by API
  key, opt-in writes via `WACRM_ENABLE_WRITES`/`WACRM_ENABLE_BROADCASTS`
  per `CLAUDE.md`). This spec is purely about **surfacing** it.
- Hosting a remote/managed MCP endpoint so the account doesn't need to
  run `npx wacrm-mcp` themselves — that's a meaningfully bigger
  infrastructure change (a long-running connection endpoint, likely
  SSE/WebSocket-based MCP transport instead of the current stdio one)
  and deserves its own spec if the account actually wants it, after
  confirming the in-app discoverability gap is the real problem first.

## Current behavior

- `mcp-server/` — separate npm package, own `package.json`/`tsconfig.json`,
  built with `tsc`. Zero business logic; every call goes through
  `/api/v1` with the account's own API key
  (`src/app/api/v1`, `src/lib/api-keys/scopes.ts`).
- `docs/mcp.md`: the quick-start (create an API key in **Settings → API
  keys**, add a `mcpServers` block to the client's config with
  `WACRM_BASE_URL` + `WACRM_API_KEY`, optionally
  `WACRM_ENABLE_WRITES`/`WACRM_ENABLE_BROADCASTS`).
- `src/components/settings/api-keys-settings.tsx`: the Settings > API
  keys panel that creates the key this flow needs — it has no mention
  of MCP, Claude, or "connect an AI assistant" anywhere in its copy.

## Proposed change

1. Add a short "Connect an AI assistant" card/section to
   `src/components/settings/api-keys-settings.tsx` (or a new
   `Settings > Integrations` section if the account grows more
   integrations later — start with the smaller change) explaining what
   MCP is in one sentence, and generating the exact `mcpServers` JSON
   block (pre-filled with the account's actual base URL and a
   newly-created key) ready to copy-paste — removes the "go read
   docs/mcp.md and hand-assemble this JSON" friction entirely.
2. Add the equivalent copy to whichever in-app help/docs surface
   already exists (if `docs/mcp.md` content is ever rendered inside
   the app itself; check before assuming it needs a second home).
3. `messages/*.json`: new strings, all four locales.

## Acceptance criteria

- [ ] From Settings > API keys, an admin can generate an MCP-ready
      config block (base URL + key filled in) without leaving the page
      or reading external docs.
- [ ] The generated config defaults to read-only (no
      `WACRM_ENABLE_WRITES`), matching `docs/mcp.md`'s stated safe
      default — an explicit toggle, not a copy-paste edit, should be
      how a user opts into write access.
- [ ] `src/i18n/*.test.ts` passes for the new strings across all four
      locales.

## Risks / open questions

- Confirm with the account/user whether "accept MCP connections" meant
  this discoverability gap (most likely, given the feature already
  fully exists) or something else entirely — e.g. the *opposite*
  direction, where wacrm's own AI auto-reply/agent config would consume
  *external* MCP servers as additional tools. If it's the latter, this
  spec doesn't apply and a different one is needed (a tool-calling
  integration point in `src/lib/ai/`, a much bigger change touching the
  provider adapters' function-calling support).
