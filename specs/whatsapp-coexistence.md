# Spec: WhatsApp Business app + Cloud API on the same number (Coexistence)

Research date: 2026-10-09. Sources at the end. Items marked **(confirm)**
were not found in Meta's official pages and must be checked before building.

## Problem

Small businesses do not want to leave the WhatsApp Business **app** on their
phone. Today the CRM forces a choice:

- **Official number (Cloud API):** the number leaves the app (registration);
  the owner can no longer answer from the phone.
- **QR (WAHA):** the app keeps working, but it is unofficial: ban risk, no
  templates, no Meta guarantees.

Meta's **"Onboard WhatsApp Business app users"** flow (a.k.a. *Coexistence*,
what YCloud, 360dialog, etc. offer) lets one number work in the app AND on
Cloud API at the same time. It is the top request of the target segment
(see specs/market-research-2026-10.md) and removes the main reason to use QR.

## Non-goals

- Group chats, calls, channels, business profile editing via API — Meta
  does not support them on coexistence numbers.
- Replacing the QR (WAHA) path: it stays for numbers that are not eligible.
- Becoming a Solution Partner (BSP, with credit lines). Tech Provider is
  enough; customers pay Meta with their own card.

## What Meta requires (official)

From the coexistence page:

- **We** must be a **Solution Partner or Tech Provider**.
- The customer's WhatsApp Business app must be **version 2.24.17+**.
- We must use **Embedded Signup with session logging**.
- Our webhook must accept and process the new fields.
- The number's country code must be supported (list not published on the
  page **(confirm)**; Brazil is supported according to partners **(confirm)**).

**Embedded Signup v2 is deprecated on 2026-10-15**; build directly on **v4**.

### Becoming a Tech Provider (our own Meta app)

1. Meta app with the WhatsApp use case and a business portfolio
   (Nordia already has the app and WABAs).
2. App Dashboard → Use cases → Customize (WhatsApp) → **Tech Provider onboarding**.
3. **Business verification** of Nordia Tech (CNPJ documents, site, phone).
   Required before App Review.
4. **App Review**:
   - app icon, privacy policy URL (`/privacidade` — check it exists),
     category;
   - two screen recordings: a message sent from our app arriving in
     WhatsApp, and our app creating a template (the CRM already does both);
   - **Advanced access** to `whatsapp_business_messaging` and
     `whatsapp_business_management`.
5. After approval: customers onboard through Embedded Signup, and each adds
   a **credit card** to their WhatsApp account (Meta bills them directly).

This step is on the Nordia side (dashboard + documents), not code. It is
the critical path; it can run in parallel with the build.

## Coexistence behaviour (official)

- **Throughput** fixed at **20 msg/s** per number (enough for our customers).
- After onboarding, in 1:1 chats the app **loses**: disappearing messages,
  view-once, live location, broadcast lists (existing ones become read-only).
- **Not on the API**: groups, calls, business tools, profile, channels.
  Edits and deletes of messages are supported.
- Companion devices: up to 4; **WhatsApp for Windows and WearOS are not
  supported**; all are unlinked at onboarding and must be re-linked.
- **Activity**: the connection drops after ~14 days without opening the app
  on the main phone (~30 days for companions); we receive `account_update`.
- **Pricing**: messages sent from the app stay **free**; messages sent via
  API are billed at Cloud API rates; app messages do **not** open or extend
  the API's 24 h customer service window.

### Webhooks to subscribe (App Dashboard → WhatsApp → Configuration)

| Field | What arrives | What we do |
|---|---|---|
| `smb_message_echoes` | messages the owner sends **from the app** (or a companion) | store as outbound **from the phone**; **must** be shown in the thread |
| `history` | past chats, up to **180 days**, in phases 0–2 with `progress`; no groups; error `2593109` = customer declined | import into conversations/messages, idempotent on wamid |
| `smb_app_state_sync` | the app's contacts, `action` `add` / `remove`, also later changes | create/update contacts (dedupe by phone) |
| `account_update` | disconnect reasons, e.g. `PARTNER_REMOVED`, inactivity | mark the number disconnected + notify admins (reuse `health_error`) |
| `account_offboarded` / `account_reconnected` | device change / re-onboarding | update number status |
| `messages` | as today, plus edit / revoke | apply edits / deletes to the stored message |

### Onboarding sequence (official)

1. Embedded Signup (v4) opened with
   `extras: { featureType: 'whatsapp_business_app_onboarding', sessionInfoVersion: '3' }`
   **(confirm the exact v4 field names)**. The WABA picker is replaced by
   "connect an existing WhatsApp Business account": the customer scans a QR
   in the app.
2. Session event `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING` → we receive the
   `code` (exchange it for a business token), the WABA id and phone number id.
3. **Do NOT call register** (`/register`) — the number is already live in the app.
4. Optional check: `GET /<PHONE_NUMBER_ID>?fields=is_on_biz_app,platform_type`
   → `true` / `CLOUD_API`.
5. Subscribe our app to the WABA (`/subscribed_apps`, already in the code).
6. **Within 24 hours** (once each, otherwise the customer must redo the flow):
   - `POST /<PHONE_NUMBER_ID>/smb_app_data` `{ "sync_type": "smb_app_state_sync" }` (contacts);
   - `POST /<PHONE_NUMBER_ID>/smb_app_data` `{ "sync_type": "history" }` (history);
   - store the returned `request_id` for support.
7. Tell the customer to keep the app **open** while the sync runs.

**Offboarding:** the API's deregister does NOT work for these numbers. The
customer disconnects in the app: Settings → Account → Business Platform →
Disconnect. We receive `account_update` `PARTNER_REMOVED`.

## Current behavior (our code)

- Numbers are added by pasting **token + phone number id + WABA id**
  (`src/components/settings/whatsapp-config.tsx`,
  `POST /api/whatsapp/config`), which then **registers** the number
  (`registerPhoneNumber`, `subscribeWabaToApp` in `lib/whatsapp/meta-api.ts`).
  Registering takes the number out of the app, which is the opposite of
  what coexistence needs.
- The webhook (`src/app/api/whatsapp/webhook/route.ts`) handles `messages`,
  `statuses` and template fields only; echoes, history and contact sync
  are ignored today.
- There is no Embedded Signup (no Facebook JS SDK, no `config_id`).
- A conversation counts as "the human took over" only by assignment or by
  pausing the AI; nothing knows the owner answered from the phone.

## Proposed change

### Phase 0 — Meta (Nordia, no code) — critical path
Business verification → Tech Provider onboarding → App Review (two
recordings + advanced access) → create an **Embedded Signup configuration**
(`config_id`) with the coexistence option, the privacy policy page, and
the webhook fields above subscribed.

### Phase 1 — Embedded Signup in the CRM (official numbers, both modes)
- Settings → WhatsApp → "Conectar com o Facebook" (Facebook JS SDK,
  `FB.login` with `config_id`, `response_type: 'code'`,
  `override_default_response_type: true`), with two options:
  **"Novo número (só API)"** and **"Usar meu WhatsApp Business do celular"**
  (coexistence, `featureType: whatsapp_business_app_onboarding`).
- `POST /api/whatsapp/embedded-signup`: exchange `code` → business token
  (server side, app secret), read the WABA / phone number from the session
  event, store a `whatsapp_config` row (encrypted token, `waba_id`,
  `phone_number_id`, new column `onboarding_mode` = `api` | `coexistence`),
  subscribe the app to the WABA. **Register only in `api` mode.**
- Respect the number limit (`canAddWhatsappNumber`) as the manual form does.
- Migration: `whatsapp_config.onboarding_mode text not null default 'api'`,
  `coexistence_synced_at timestamptz`, `coexistence_sync_request_ids jsonb`.
- Env: `NEXT_PUBLIC_META_APP_ID`, `NEXT_PUBLIC_META_ES_CONFIG_ID`
  (`META_APP_SECRET` already exists).
- The manual paste form stays as "avançado" (self-host installs).

### Phase 2 — coexistence sync and echoes
- Right after onboarding (and a retry in the cron while within 24 h):
  call `smb_app_data` for contacts and history once; store the request ids.
- Webhook:
  - `smb_message_echoes` → insert the message as **outbound**, new
    `messages.sent_from = 'business_app'` (or `sender_type 'agent'` with
    a flag), idempotent on wamid; update the conversation's last message.
  - `history` → import per phase into conversations/messages (oldest
    first), idempotent; show import progress on the number card.
  - `smb_app_state_sync` → upsert contacts by phone (existing dedupe).
  - `account_update` / `account_offboarded` / `account_reconnected` →
    number status + `health_error` + admin notification (reuse
    `runOfficialNumberHealth`'s notification path).
  - `messages` edit / revoke → update / mark deleted.
- Inbox: an echo shows as "Enviada pelo celular" (badge), like a human reply.

### Phase 3 — AI and rules with a person on the phone
- An echo means **a person answered from the phone**: treat it as a human
  takeover for that conversation (pause the AI with reason
  `phone_reply`, the same pattern as `flow_handoff`), configurable per
  number: "pausar a IA quando eu responder pelo celular" (default on).
- `claim_ai_reply_turn` already refuses when the AI is paused — an echo
  arriving while the AI is writing drops the AI's reply.
- Follow-ups: an echo counts as a business reply (it does not count as the
  customer answering). **(decide)**
- Templates and the 24 h window: app messages do not open the API window;
  the composer must keep using the window computed from customer messages
  only (already the case).

### Phase 4 — polish
- Number card shows: mode (API / Celular + API), sync progress, last
  activity warning ("abra o WhatsApp Business no celular" before the
  14-day disconnect, from `account_update` or from our own last-echo date).
- Help page: what changes in the app after connecting (lost features,
  Windows app unsupported) — shown before the customer confirms.

## Acceptance criteria

- [ ] A customer connects their WhatsApp Business app number from Settings
      without pasting any token, and keeps using the app on the phone.
- [ ] Messages received on that number appear in the CRM; replies sent from
      the CRM arrive to the customer; replies sent from the phone appear in
      the CRM thread marked as sent from the phone.
- [ ] Up to 180 days of history and the app's contacts are imported once,
      without duplicates on retries.
- [ ] When the owner replies from the phone, the AI stops answering that
      conversation (configurable).
- [ ] Disconnecting in the app (or 14 days of inactivity) shows the number
      as disconnected and notifies the admins.
- [ ] "Só API" mode still works (registers the number as today).
- [ ] Migrations extend `supabase/ci/verify-schema.sql`; webhook handlers
      are unit-tested with recorded payloads.

## Risks / open questions

- **Meta approval time** (business verification + App Review) is outside
  our control; start Phase 0 now.
- Exact **v4** Embedded Signup parameters and the supported country list —
  confirm on the current Meta pages when Phase 0 completes.
- History import volume (180 days) on large accounts: process in the
  `after()`/cron with batches; respect the 1000-row PostgREST limit.
- Pricing explanation to customers: API messages are billed, app messages
  are free — the number card should say so.
- Third-party claims (e.g. "7 days of app activity before onboarding",
  "business verification of the customer") are **not** in Meta's docs —
  do not enforce them unless Meta returns an error.
- The deprecation of Embedded Signup v2 on 2026-10-15 does not affect us
  (we have none yet), but every example online older than that is v2/v3.

## Sources

- Meta — Onboard WhatsApp Business app users (Coexistence):
  https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users
- Meta — Get started for Tech Providers:
  https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/get-started-for-tech-providers
- 360dialog — Using WhatsApp App and Cloud API simultaneously:
  https://docs.360dialog.com/partner/waba-management/phone-number-and-hosting/using-whatsapp-app-and-cloud-api-simultaneously
