# Spec: Unofficial WhatsApp API as an alternative connection method

> Exploratory — sizing and architecture options, not a ready-to-build
> plan. This is a genuinely large change; the "Proposed change" section
> ends with a recommended *narrow* first slice rather than full parity,
> on purpose.

## Problem

wacrm only supports connecting a number through Meta's official
WhatsApp Business Platform (Cloud API): an app on Meta for Developers,
a WABA, a phone number registered with `/register`, and webhooks
subscribed via `subscribeWabaToApp`. That path requires a Meta Business
verification, has per-conversation pricing, and — as
`specs/inbox-response-time-sla.md`-adjacent support history shows
(`docs/whatsapp-connection-troubleshooting.md`) — has enough setup
friction (WABA/phone mismatches, PIN registration, app review for
template categories) that some users want a lower-friction alternative
for personal numbers or small-volume use: an "unofficial" WhatsApp Web
automation library (e.g. Baileys, whatsapp-web.js) that logs in via QR
code like WhatsApp Web itself, no Meta account or app review required.

## Non-goals

- **Achieving full feature parity in one pass.** The official
  integration supports typed templates with Meta approval,
  interactive messages (buttons/lists), broadcast campaigns with
  resumable delivery (`src/lib/whatsapp/broadcast-resume.ts`), template
  status webhooks, and inbound-media mirroring. An unofficial-API
  provider cannot replicate several of these at all (there is no
  "template" concept outside Meta's platform) and would need its own
  design for the ones it can (media, read receipts, typing indicators
  are all differently shaped). Ship send/receive text + media first;
  treat everything else as follow-up work per capability.
- **Recommending a specific library as final.** Baileys and
  whatsapp-web.js differ meaningfully (Baileys is a from-scratch
  Signal-protocol implementation and doesn't need a headless browser;
  whatsapp-web.js drives an actual Chromium instance via Puppeteer).
  This spec assumes a Baileys-shaped adapter (lighter, no Chromium
  dependency, better fit for the `next build --output standalone` /
  Docker deploy story already in `CLAUDE.md`) but the final choice
  needs its own evaluation.
- **Legal/ToS risk assessment.** Automating WhatsApp outside its
  official Business Platform is against WhatsApp's Terms of Service
  and numbers using it risk being banned by Meta with no appeal path.
  This spec covers the engineering shape only; the account owner needs
  to decide whether to ship this at all, and if so, how prominently to
  disclose the risk in-product (see open questions).
- **Multi-session scaling** (many unofficial-API connections run
  concurrently on one server, each needing its own persistent
  WebSocket + auth-state storage) — start with one connection per
  account, same cardinality the Cloud API already assumes
  (`whatsapp_config` is one row per account, unique on
  `phone_number_id`).

## Current behavior

The Cloud API is not behind an interface — it's called directly
throughout the codebase. `src/lib/whatsapp/meta-api.ts` is imported by
21 files, including:

- `src/app/api/whatsapp/webhook/route.ts` — the inbound entrypoint;
  assumes a Meta webhook payload shape (`metadata.phone_number_id`
  resolves the account, migration 013's unique index enforces
  one-number-per-account).
- `src/lib/whatsapp/send-message.ts`, `broadcast-core.ts`,
  `src/lib/flows/meta-send.ts`, `src/lib/automations/meta-send.ts` —
  every outbound send path calls Meta's Graph API directly.
- `src/app/api/whatsapp/config/route.ts` — the connect flow itself:
  `verifyPhoneNumber`, `registerPhoneNumber`, `subscribeWabaToApp`, all
  Cloud-API-specific calls with no equivalent concept in an unofficial
  client (there's no "app," "WABA," or "/register" step — a QR-code
  login *is* the registration).
- `src/types` / `whatsapp_config` schema: columns are Cloud-API-shaped
  (`phone_number_id`, `waba_id`, `access_token`, `verify_token`).

There is currently **zero abstraction layer** — nothing like
`src/lib/ai/providers/`'s shared interface exists for WhatsApp
connectivity. Every call site assumes exactly one implementation.

## Proposed change

1. **Introduce a provider interface** before writing any unofficial-API
   code, modeled on `src/lib/ai/providers/`'s pattern (`AiProvider` or
   equivalent shared shape): a `WhatsAppProvider` interface covering
   the actual operations call sites need — `sendText`, `sendMedia`,
   `onInboundMessage` (or an equivalent event/callback shape), `status`
   — and migrate the existing Cloud API code behind a
   `CloudApiProvider` implementation first, as a pure refactor with
   *no behavior change*. This is the highest-risk step precision-wise
   (21 call sites) and should land and be verified in isolation before
   any unofficial-API code exists, so a regression is attributable to
   the refactor alone.
2. **Schema**: add `whatsapp_config.connection_type`
   (`'cloud_api' | 'unofficial'`, default `'cloud_api'`), and either a
   separate `whatsapp_unofficial_sessions` table (auth-state blob,
   connection status, last-seen) or a `jsonb` column scoped to the
   unofficial path only — keep Cloud-API-only columns
   (`phone_number_id`, `waba_id`, `access_token`) nullable/unused for
   unofficial rows rather than repurposing them.
3. **Connection flow**: an unofficial provider's "connect" step is a
   QR code, not a form. New UI: a `Settings > WhatsApp` mode toggle
   (Cloud API vs. "Connect via QR code — experimental"), then a QR
   code rendered from the provider library's auth event, polled/pushed
   via Supabase Realtime (already used elsewhere in this stack, per
   `AGENTS.md`'s Realtime mention) until the library reports
   `connected`.
4. **Session persistence & process model**: an unofficial client holds
   a long-lived WebSocket connection to WhatsApp's servers — this
   doesn't fit the request/response model of a Next.js API route.
   Needs either a separate long-running Node process (a new deployable
   alongside the Next.js app, not a serverless function) or a
   durable-connection service. This is the single biggest
   infrastructure departure from everything else in the repo, which is
   entirely request/response (`src/app/api/**`) plus a `cron`-drained
   `automation_pending_executions` queue — nothing here currently
   assumes a stateful long-running process per account. Auth-state
   (the encrypted session credentials Baileys persists) needs storage
   that survives restarts — Supabase Storage, keyed and encrypted the
   same way `access_token` is today (`src/lib/whatsapp/encryption.ts`).
5. **Webhook equivalent**: the unofficial provider's inbound-message
   event needs to funnel into the *same* downstream pipeline the Cloud
   API webhook uses today (Flows engine → automations → AI auto-reply
   → outbound webhooks, per `CLAUDE.md`'s webhook fan-out description)
   without duplicating that orchestration logic. Extract the
   post-resolution part of `src/app/api/whatsapp/webhook/route.ts`
   (contact resolve/dedupe → conversation resolve → persist → fan-out)
   into a shared function both the Cloud API webhook route and the
   unofficial provider's event handler call, so the two connection
   types converge onto one pipeline immediately after receiving a
   message rather than each reimplementing it.

## Acceptance criteria

- [ ] The `CloudApiProvider` refactor lands with no behavior change —
      every existing WhatsApp test still passes unmodified, and a
      manual send/receive smoke test on a real Cloud API number
      confirms parity before any unofficial-API code is written.
- [ ] An account can choose "Connect via QR code" in Settings, scan it,
      and land in a `connected` state without touching Meta for
      Developers at all.
- [ ] An inbound text message on an unofficial connection reaches the
      same conversation/message rows, in the same shape, as a Cloud API
      message would — verified by both connection types' inbound paths
      converging on the same shared handler (not two parallel
      implementations that happen to produce similar output).
- [ ] Automations and Flows can send a reply over an unofficial
      connection using the same trigger/step configuration a Cloud API
      account would use — no automation-author-facing difference
      between the two connection types for the capabilities that exist
      on both.
- [ ] The in-app UI clearly discloses that the unofficial connection
      type risks a WhatsApp-side ban and is not an official integration
      — exact copy TBD with the account owner (see open questions).

## Risks / open questions

- **Ban risk is real and user-facing.** WhatsApp actively detects and
  bans numbers using unofficial clients, with no recourse. This needs
  explicit, prominent disclosure before a user connects this way — a
  one-line settings hint is not enough. Confirm with the account owner
  what the disclosure/consent flow should look like (a checkbox
  acknowledgment? a modal on first connect?) before shipping.
- **Process/infrastructure model.** Per point 4 above, this needs a
  long-running process that doesn't exist in the current deploy story
  (`Dockerfile`, `docker-compose.yml`, Vercel-style serverless
  `next build --output standalone`). Decide whether that's a sidecar
  container in the existing `docker-compose.yml`, a separate Fly.io/
  Railway-style always-on service, or something else — this changes
  the self-hosting docs (`docs/docker.md`) materially and is worth
  resolving before implementation, not during.
- **Which library.** Baileys vs. whatsapp-web.js vs. others — needs a
  short spike comparing maintenance activity, Chromium dependency
  weight, and how each handles multi-device session persistence,
  before committing to the schema in point 2.
- **Template-less messaging.** The Cloud API's 24-hour customer-service
  window + approved-template-for-outside-window rule has no unofficial
  equivalent (there's no template concept at all) — decide whether
  outbound messages on an unofficial connection are simply
  unrestricted (closer to how a human uses WhatsApp Web) or whether
  wacrm should self-impose a similar window to keep automation
  behavior consistent across connection types.
