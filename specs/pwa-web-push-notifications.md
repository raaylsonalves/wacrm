# Spec: PWA + Web Push notifications

**Status (2026-09-30): implemented (manifest, service worker, push subscriptions — migration 071 — and a dispatcher driven by the cron). The live push path can only be checked on a deployed server with VAPID keys.**

> Triggered by a real bug report: a user on a mobile browser saw
> "this browser doesn't support notifications." Investigated and
> confirmed — wacrm has zero PWA infrastructure today (no manifest, no
> service worker), and the existing "browser notifications" feature is
> the synchronous `Notification` API fired from an open dashboard tab,
> which mobile browsers correctly report as unsupported outside an
> installed context. This spec covers making the app installable and
> adding real Web Push so notifications can arrive even with the
> browser closed — on desktop and mobile.

## Problem

`src/hooks/use-browser-notifications.ts` shows a desktop `Notification`
alert when a new inbound message lands via Supabase Realtime — but only
while a dashboard tab is open (its own doc comment says so explicitly:
"there is no service worker or Web Push here, so a closed browser stays
quiet"). On mobile this fails outright:

- **iOS Safari**: `window.Notification` doesn't exist in a regular
  browser tab at all. Apple only exposes it to a web app added to the
  home screen (iOS 16.4+) — which requires a manifest and a registered
  service worker, neither of which exist in this repo.
- **Android Chrome**: the API exists, but `new Notification()` called
  directly from a page (not from a service worker) is frequently
  blocked — the existing code's own comment already anticipates this
  ("Android Chrome requires a service worker").

wacrm has no `manifest.json`, no service worker file anywhere in
`public/`, and nothing in `next.config.ts` wires one up. It is not
installable and cannot receive push while closed or backgrounded,
on any platform.

## Non-goals

- **Full offline support.** This is a live-data dashboard (Realtime
  subscriptions, fresh inbox state) — aggressively caching pages for
  offline use would actively mislead an agent into replying from stale
  data. The service worker here exists ONLY to receive push events and
  show notifications; it does not intercept `fetch` or cache app
  routes.
- **Rich notification actions** (reply-from-notification, quick
  actions). v1 matches today's behavior: tapping a notification opens
  the app to that conversation, same as the existing desktop alert's
  `onclick` (`use-browser-notifications.ts:110-114`).
- **Replacing the existing tab-open Realtime alert.** Keep both: the
  Realtime listener gives instant, zero-latency alerts while a tab is
  open; Web Push is the ONLY path that works with the browser closed
  or the phone locked, but push delivery on mobile OSes is
  batched/delayed by design (not instant). They serve different
  moments, not the same one.
- **Choosing a native app / Capacitor / React Native wrapper.** Making
  the existing web app installable (PWA) is a much smaller change and
  solves the reported problem; a native wrapper is a different,
  much larger project.

## Current behavior

- `src/hooks/use-browser-notifications.ts` — Realtime `postgres_changes`
  listener on `messages`, calls `new Notification(...)` directly
  (line 103). Dies silently (caught) if the browser throws.
- `src/lib/notifications/browser-notify.ts` — pure helpers:
  `getNotificationPermission()` returns `'unsupported'` when
  `!('Notification' in window)`; `shouldNotifyForMessage()` decides
  whether a given message warrants an alert (not viewing that
  conversation, tab not focused, not already assigned elsewhere, not
  deduped).
- `src/components/settings/browser-notifications-card.tsx` — Settings
  UI: permission toggle, "send test notification" button, renders
  `t('unsupported')` when the API doesn't exist. This is a
  device-local preference (`localStorage`, `readBrowserNotifyPref`),
  never synced to the server.
- `src/app/icon.tsx` — the only icon asset today: a 32×32 PNG generated
  at request time via `next/og`'s `ImageResponse` (edge runtime), used
  for the favicon. No 192×192/512×512 variants exist anywhere.
- No `public/manifest.json`, no `public/sw.js` (or any service worker),
  no `next-pwa`/workbox dependency, nothing in `next.config.ts`.
- No table anywhere stores a push subscription (endpoint + keys).

## Proposed change

### 1. Make the app installable — manifest + icons

- `src/app/manifest.ts` (Next.js's metadata-file convention — same
  mechanism `icon.tsx` already uses, just the manifest variant; no new
  routing concept to learn). Returns `name`, `short_name`,
  `start_url: '/dashboard'`, `display: 'standalone'`,
  `background_color`/`theme_color` matching `viewport.themeColor` in
  `src/app/layout.tsx` (`#020617`), and an `icons` array.
- Icons: extend `src/app/icon.tsx`'s existing `ImageResponse` pattern
  to also emit 192×192 and 512×512 PNGs (Next's `generateImageMetadata`
  export lets one file produce several sized variants — reuse the
  exact same brand-mark JSX already there, just parameterized by
  size), plus one maskable variant (`purpose: 'maskable'`, safe-area
  padding per the [maskable.app](https://maskable.app) guidelines —
  needed for Android's adaptive icon shape).
- `src/app/layout.tsx`: Next.js auto-links `manifest.ts`'s output the
  same way it already auto-injects `icon.tsx`'s `<link rel="icon">` —
  no manual `<link rel="manifest">` needed, but verify the injected
  tag in a build.

### 2. Service worker — push + click only, nothing else

`public/sw.js`, hand-rolled (no Workbox/`next-pwa` — this app's own
convention is to hand-roll rather than pull a dependency for something
this small; see `src/lib/rate-limit.ts`'s own in-memory limiter or the
custom AES helper in `src/lib/whatsapp/encryption.ts` for precedent).
Two listeners only:

```js
self.addEventListener('push', (event) => {
  const data = event.data?.json() ?? {};
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      tag: data.conversationId, // one alert per conversation, mirrors use-browser-notifications.ts's `tag`
      icon: '/icon',
      data: { url: data.url },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(clients.openWindow(event.notification.data.url));
});
```

Registered from a new client hook, `src/hooks/use-push-registration.ts`
— called once from the same place `<BrowserNotificationsListener />`
already mounts (`(dashboard)` layout). Registration is inert (no-op)
when `!('serviceWorker' in navigator)`, same defensive style as
`getNotificationPermission()`.

### 3. Schema — one row per device subscription

```sql
CREATE TABLE push_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  endpoint text NOT NULL,
  p256dh text NOT NULL,
  auth_key text NOT NULL,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (endpoint)
);
```

A user gets one row per device/browser they've enabled push on (a
phone and a laptop both subscribed = 2 rows) — `endpoint` is globally
unique per browser+origin, so `UNIQUE (endpoint)` alone is the natural
upsert key. RLS: a user reads/deletes only their own rows
(`user_id = auth.uid()`); writes happen from the client (subscribing is
a self-service action, same trust level as the existing `localStorage`
toggle) but reads for SENDING happen server-side under
`supabaseAdmin()`, same pattern as `whatsapp_config`'s webhook lookup.

### 4. VAPID keys + the send path

- Generate one VAPID keypair for the deployment (`npx web-push
  generate-vapel-keys` — one-time, per the `web-push` npm package's own
  CLI). Store as env vars: `NEXT_PUBLIC_VAPID_PUBLIC_KEY` (the
  subscribe call needs it client-side), `VAPID_PRIVATE_KEY`,
  `VAPID_SUBJECT` (a `mailto:` contact, required by the spec). Document
  in `.env.local.example` next to the other optional secrets.
- `src/lib/push/send.ts` — thin wrapper over the `web-push` package's
  `sendNotification()`, the same "one new small lib module" pattern as
  `src/lib/whatsapp/waha-api.ts`. `sendPushToAccount(accountId,
  payload, opts)`: loads that account's `push_subscriptions` under
  `supabaseAdmin()`, sends to each, and DELETES any subscription that
  comes back `410 Gone` / `404` (the browser unsubscribed or the
  endpoint expired) — without this cleanup the table silently
  accumulates dead rows forever.
- **Call site**: both inbound webhooks — `src/app/api/whatsapp/webhook/
  route.ts` (Cloud API) and `src/app/api/whatsapp/webhook/waha/route.ts`
  (WAHA) — inside their existing `after()` fan-out, alongside
  `dispatchInboundToAiReply`/`runAutomationsForTrigger`. This is the
  one piece Realtime can't cover: a closed tab has no open Realtime
  socket, so the PUSH itself must originate server-side, at the exact
  point the message is already known to have landed. Reuse
  `shouldNotifyForMessage`'s non-DOM logic (assigned-elsewhere check,
  dedupe) — the DOM-only parts (`document.visibilityState`,
  "already viewing this conversation") don't apply server-side and are
  skipped; a push while the user IS looking at the conversation in an
  open tab is a redundant but harmless alert, not a correctness bug.

### 5. Settings UI

Extend `browser-notifications-card.tsx` (not a new panel — same
card, an added capability) with a second toggle: "Push notifications
(works even when this browser is closed)". Enabling it: registers the
SW if not already, requests `Notification` permission if not granted,
calls `pushManager.subscribe({ userVisibleOnly: true, applicationServerKey:
<the public VAPID key> })`, POSTs the subscription to a new
`/api/notifications/push-subscription` route (mirrors `/api/ai/config`'s
POST-is-upsert shape), admin-gate NOT required (a user manages their
own device subscriptions, not an account-wide setting — closer to the
personal `localStorage` toggle's trust level than to `whatsapp_config`).

On iOS specifically, show an explicit banner when `!window.matchMedia
('(display-mode: standalone)').matches` — Safari does not fire
`beforeinstallprompt` (that's Chromium-only), so the UI must tell an
iOS user in words: "Open this page in Safari → Share → Add to Home
Screen, then come back here to enable push" — there is no
programmatic install trigger to fall back to on iOS.

## Acceptance criteria

- [ ] The app is installable on Android Chrome (an install prompt or
      the browser menu's "Install app" appears) and on iOS Safari via
      manual "Add to Home Screen."
- [ ] A user who enables push on their phone (installed PWA) receives
      a notification for a new inbound message with the phone locked
      and the app not open.
- [ ] Tapping that notification opens the app to the right conversation.
- [ ] A subscription that the push service reports as gone (410/404) is
      removed from `push_subscriptions` on the next send attempt, not
      retried forever.
- [ ] The existing tab-open desktop `Notification` alert still fires
      identically — this is additive, not a replacement.
- [ ] `npm run test:unit` covers `send.ts`'s 410/404 cleanup logic and
      the manifest's icon sizes, mirroring how `webhook-signature.test.ts`
      covers the existing webhook's crypto.

## Risks / open questions

- **iOS's install requirement is a real UX cliff.** Every iOS user
  must manually "Add to Home Screen" before push works at all — there
  is no way to make this automatic or even promptable on iOS Safari.
  The in-app banner (proposed change #5) is a mitigation, not a fix;
  set expectations that iOS adoption of this feature will be lower
  than Android's.
- **Where do `NEXT_PUBLIC_VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` live
  for self-hosted forks?** Same pattern as `ENCRYPTION_KEY` — generated
  once per deployment, documented in `.env.local.example`, and a
  missing key should degrade to "push disabled, tab-open alerts still
  work" rather than a hard failure (mirrors how a missing embeddings
  key degrades semantic search to lexical-only, not a crash).
- **Multiple devices per user, one conversation.** If a user has push
  enabled on both a phone and a laptop, and the laptop tab is open and
  already showed the Realtime alert, the phone still gets a push (a
  different device, no way to know the laptop already "handled" it
  from the phone's perspective). Acceptable — matches how every other
  multi-device push app (WhatsApp itself included) behaves.
- **Delivery isn't instant.** Mobile OS push batching (especially iOS)
  can delay delivery by seconds to a couple of minutes under battery
  optimization. Not fixable from the app side; worth setting
  expectations rather than treating as a bug if reported later.
