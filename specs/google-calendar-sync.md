# Spec: Google Calendar sync for the agenda

> Ported in spirit from deskcomm's `lib/agenda/google/*` (`oauth.ts`,
> `transport.ts`, `sync-executor.ts`, cron `agenda-google-sync`) — but
> deliberately **smaller**: deskcomm built a full two-way sync with
> conflict fences, checkpoints and attendee invites. This spec delivers
> the part a small business actually needs first: *bookings the AI or the
> dashboard makes appear in the owner's Google Calendar, and events the
> owner puts in Google block those hours for the AI.* Two-way edits are a
> later phase. This is the missing half of the "just automate my
> WhatsApp + bookings" service (see `specs/operator-multi-account.md`).

## Problem

The agenda (`specs/agenda-appointments.md`, migration 058) is entirely
internal. The AI can book a slot (`src/lib/ai/tools/agenda.ts`) and the
dashboard can create one, but:

- A barber/clinic owner lives in Google Calendar on their phone. A booking
  that only exists inside wacrm is a booking they don't see — so they
  double-book by hand, or have to open another app to check.
- The reverse is worse: they block a lunch or a day off **in Google**, and
  the AI keeps offering those hours to customers, because it only knows
  wacrm's own `appointments` table.

`agenda-exploratory.md:20,45` and `agenda-appointments.md:7` deferred this
explicitly ("sem sincronização externa na v1"). It is now the thing that
decides whether the agenda is usable for the target customer.

## Non-goals

- **Two-way edit of wacrm-owned events in phase A.** Moving a booking in
  Google moving it in wacrm is phase B (needs conflict rules).
- **Inviting the customer** as a Google attendee (sends them e-mail from
  Google, has side effects the shop didn't ask for). Optional flag, off.
- **Other providers** (Outlook, CalDAV, iCloud). The schema is provider-
  agnostic; only Google is implemented.
- **Push notifications from Google (`events.watch` webhooks).** Polling
  every few minutes is enough and needs no public endpoint/renewal loop.
- **Professionals/chairs as bookable resources without a login.** See open
  questions — real for barbershops, but a separate design.

## Current behavior

- `appointments` (migration 058): `assigned_to uuid` → `auth.users`
  (`NULL` = the account's shared calendar), `starts_at/ends_at
  timestamptz`, `status`, `source`, `title`, `notes`. Double booking is
  prevented **in Postgres** by the `appointments_no_overlap` exclusion
  constraint (per `assigned_to`, non-cancelled).
- `appointment_settings`: `timezone`, `work_days`, `day_start/day_end`,
  `slot_minutes`, reminder config.
- Availability is computed in `src/lib/appointments/slots.ts` from those
  settings plus **`loadBusyRanges()`**
  (`src/lib/appointments/store.ts:54`) — the single function that says
  "what's already taken". Every consumer (dashboard picker, the
  `offer_slots` flow node, the AI agenda tools) goes through it.
- Appointments are **written from four places**: the dashboard straight
  from the browser through RLS (`appointments_insert/update/delete`,
  agent+), the AI tools and the `offer_slots` flow under the service
  role, and the reminder cron (`reminder_sent_at`). A server-side hook
  cannot see the browser writes — same constraint that pushed channel
  routing (migration 069) and follow-up cancellation into Postgres.
- Encryption for third-party tokens already exists
  (`src/lib/whatsapp/encryption.ts`, AES-256-GCM under `ENCRYPTION_KEY`).
- No Google OAuth anywhere in the repo (`signInWithOAuth` has zero hits);
  login is Supabase email/password.

## Proposed change

### 1. Schema (migration, next free number)

```sql
CREATE TABLE IF NOT EXISTS calendar_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- NULL = the account's shared calendar; else that member's own.
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  provider text NOT NULL DEFAULT 'google' CHECK (provider IN ('google')),
  google_email text NOT NULL,
  google_calendar_id text NOT NULL,
  refresh_token_enc text NOT NULL,      -- AES-256-GCM, never returned
  scopes text[] NOT NULL,
  sync_token text,                      -- events.list incremental token
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','needs_reauth','disabled')),
  last_synced_at timestamptz,
  last_error text,
  include_customer_phone boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- one shared connection per account, one per member
CREATE UNIQUE INDEX uq_calendar_conn_shared
  ON calendar_connections (account_id) WHERE user_id IS NULL;
CREATE UNIQUE INDEX uq_calendar_conn_member
  ON calendar_connections (account_id, user_id) WHERE user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS appointment_google_events (
  appointment_id uuid PRIMARY KEY REFERENCES appointments(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES calendar_connections(id) ON DELETE CASCADE,
  google_event_id text NOT NULL,
  etag text,
  synced_at timestamptz,
  last_error text
);

-- Events that exist ONLY in Google (personal, lunch, day off): they
-- block slots but must never become `appointments` rows (they'd trip the
-- exclusion constraint and pollute reports).
CREATE TABLE IF NOT EXISTS calendar_busy_blocks (
  connection_id uuid NOT NULL REFERENCES calendar_connections(id) ON DELETE CASCADE,
  google_event_id text NOT NULL,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  PRIMARY KEY (connection_id, google_event_id)
);
CREATE INDEX idx_busy_blocks_range
  ON calendar_busy_blocks (account_id, starts_at, ends_at);

-- Outbox: written by a trigger, drained by the worker. This is what makes
-- browser-originated writes visible to the sync at all.
CREATE TABLE IF NOT EXISTS calendar_sync_outbox (
  id bigserial PRIMARY KEY,
  account_id uuid NOT NULL,
  appointment_id uuid NOT NULL,
  op text NOT NULL CHECK (op IN ('upsert','delete')),
  attempts smallint NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
-- + AFTER INSERT/UPDATE/DELETE trigger on appointments enqueuing rows
--   (coalesced: one pending row per appointment).
```

RLS: `SELECT` on `calendar_connections` (without the token column — expose
via a view or column-level privilege) and `calendar_busy_blocks` for
members; **no client write policies**; tokens, outbox and mapping are
service-role only. `SECURITY DEFINER` isn't needed — routes use the
service role after `requireRole`.

### 2. OAuth connection

- Env: `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`; both absent
  → the whole feature is hidden (same degrade-gracefully rule as VAPID).
- `GET /api/integrations/google-calendar/start` (admin+; `?member=` for a
  personal calendar): builds the consent URL with **`access_type=offline`
  and `prompt=consent`** (otherwise Google omits the refresh token on
  re-consent), a `state` that is an **HMAC-signed, expiring blob** binding
  `{accountId, userId, nonce}` (CSRF + account binding), PKCE.
- `GET …/callback`: verifies `state`, exchanges the code, requires the
  refresh token, reads the account's calendar list, stores the
  **encrypted** refresh token. Never logs tokens; errors are generic.
- **Calendar choice**: connect to the primary calendar, or create a
  dedicated "Agendamentos" calendar (recommended default — owner can hide
  it, and a narrow scope suffices to manage it).
- `invalid_grant` on refresh → `status = 'needs_reauth'`, a
  `notifications` entry + banner in Settings; sync pauses, nothing is
  deleted.
- **Scopes**: request the minimum that does the job (events on the chosen
  calendar + reading busy time). Confirm the current scope list and which
  are "sensitive" at implementation time — see Risks; this decides
  whether Google verification is needed.

### 3. Push: wacrm → Google (phase A)

Worker `src/lib/appointments/google-sync.ts`, drained from the existing
`GET /api/automations/cron` (no new pinger), batch-bounded, claim via
`UPDATE … WHERE next_attempt_at <= now() … RETURNING`:

- **Idempotent creates**: send a deterministic, valid Google event id
  (lowercase hex of `sha1(appointment.id)`) so a retried create that
  already succeeded returns `409` and is treated as success (then
  `PATCH`). Also stamp
  `extendedProperties.private.wacrmAppointmentId` (used by phase B and to
  tell our events from the owner's own when pulling).
- `upsert` → create/`PATCH` the event: `summary` = title (+ contact name),
  `start/end` with `timeZone = appointment_settings.timezone`,
  `description` = notes + (if `include_customer_phone`) phone + a link
  back to the conversation; no attendees; Google's own default reminders
  are left alone (the owner *wants* the phone alert).
- `delete` (appointment cancelled / deleted) → `DELETE` the event;
  `404/410` = already gone = success.
- Routing: `assigned_to = X` → X's connection if present, else the shared
  one; no connection → not synced (no error, no outbox spam).
- Failures: exponential backoff on `5xx/429` (respect `Retry-After`);
  permanent `4xx` recorded in `appointment_google_events.last_error` and
  surfaced in the UI — never retried forever, never blocks the booking
  itself. **Google being down must not fail an appointment.**

### 4. Pull: Google → busy blocks (phase A)

Per active connection, each cron tick: `events.list` with the stored
`syncToken` (incremental); first run uses `timeMin = now-1d`,
`timeMax = now+90d`, `singleEvents = true`. For each event:

- has our `wacrmAppointmentId` → **ignore in phase A** (it's our own echo);
- `status = cancelled` → delete its block;
- `transparency = transparent` ("free") or declined by the owner → no block;
- otherwise upsert `calendar_busy_blocks` (all-day busy events block the
  day in the account's timezone).
`410 Gone` on the sync token → drop it and do a bounded full resync.

**`loadBusyRanges()` (`store.ts:54`) unions `calendar_busy_blocks`** for
the relevant connection — the one edit that makes the dashboard picker,
`offer_slots`, and the AI agenda tools all respect Google-side blocks.

**Known race (documented, accepted):** the exclusion constraint cannot
cover Google-only events, so if the owner adds a personal event *and* the
AI books that hour within one polling interval, both exist. Mitigation: a
final freshness check — before the AI confirms a slot, re-list just that
window for the connection (one cheap call); and on a detected overlap,
notify the owner instead of silently keeping both.

### 5. Phase B (separate delivery): edits made in Google

Event carrying `wacrmAppointmentId` whose time changed or was deleted in
Google → apply to the appointment (`updated` timestamp wins; changes
outside working hours or overlapping another booking are **rejected and
reported**, not forced through the exclusion constraint). Cancel in Google
→ appointment `cancelled`, customer optionally notified via the existing
reminder path.

### 6. UI

Settings → Agenda → **Google Agenda** card: Connect / connected e-mail /
calendar / last sync / error banner / Disconnect (revokes the token with
Google, stops sync, keeps already-created events by default). The agenda
page renders Google blocks as striped grey "Ocupado (Google)" and shows a
small "sincronizado" mark on synced bookings. **Connect link** (for the
operator model): an admin can generate a single-use, expiring link that
opens the OAuth flow for a *client* to authorize their own Google account
— so the operator never handles the client's password
(`operator-multi-account.md`).

## Acceptance criteria

- [ ] Creating, moving and cancelling an appointment — **from the
      dashboard (browser path)**, from the AI, and from a flow — shows up
      in Google within one sync interval, exactly once each (retrying the
      worker does not duplicate events).
- [ ] An event added in Google blocks that time for the dashboard picker,
      the `offer_slots` node and the AI tools; deleting it frees the time.
- [ ] `transparent`/declined/cancelled Google events do not block.
- [ ] A Google outage or revoked token never fails or delays booking;
      `invalid_grant` flips the connection to `needs_reauth` and alerts an
      admin.
- [ ] Refresh tokens are stored encrypted and never appear in any API
      response, log line or client bundle; the OAuth `state` is signed,
      expiring and account-bound (a forged/replayed callback is rejected).
- [ ] Appointments with no matching connection are simply not synced.
- [ ] Unit tests: event-id derivation, outbox coalescing, busy-block
      projection (all-day, timezone edges, transparency), `Retry-After`
      backoff, `410` resync; `verify-schema.sql` asserts tables, both
      partial unique indexes and the outbox trigger; all four locales.
- [ ] With the two env vars unset the feature is invisible and nothing
      errors.

## Risks / open questions

- **Google app verification is the biggest non-code risk.** Reading or
  writing events uses a *sensitive* scope, and an OAuth consent screen in
  "Testing" status limits users and — as Google documents it — expires
  refresh tokens after a short period, which would silently break sync a
  week after connecting. An unverified app published "in production" shows
  a scary warning screen and is capped on user count until verified. For
  an operator with a few dozen clients that may be tolerable at first;
  beyond that, verification (privacy policy, demo video, weeks of review)
  is required. **Confirm current limits and pick scopes accordingly before
  building** — this can change the design (e.g. a dedicated calendar with
  a narrower scope).
- **Barbershops have professionals who aren't users.** `assigned_to`
  references `auth.users`, so each barber must be a seat. A real "resource"
  concept (name + hours + own calendar, no login) is likely the next need;
  not designed here.
- **LGPD/privacy.** Customer name/phone go to Google on the *business's*
  account. `include_customer_phone` (default on) lets an owner strip it;
  document the controller/processor position in the operator docs.
- **Recurring/all-day/multi-day events** in the owner's calendar have
  edge cases (timezone of all-day events, `singleEvents` expansion window).
  Covered by unit tests; expect real-world surprises.
- **Cron cadence** again decides latency (5-minute ping recommended).
- **Second Google Cloud project per deployment.** Self-hosters must create
  their own OAuth client; the docs must say how (redirect URI, scopes).
