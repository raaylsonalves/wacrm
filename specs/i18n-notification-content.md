# Spec: Localize notification title/body

> **Status: implemented** (migration `048_notification_i18n_fields.sql`).
> The shipped approach differs slightly from the one proposed below: it
> adds `actor_name`/`contact_name` columns directly to `notifications`
> (populated by the trigger) rather than joining `contacts`/`profiles`
> client-side, and makes `title`/`body` nullable instead of dropping
> them — same end result (the notifications page renders the sentence
> via next-intl in the viewer's locale), simpler data path. Left this
> file as historical context rather than deleting it.

## Problem

`/notifications` always shows "New conversation assigned" and
"<Name> assigned you a conversation with <Contact>" in English,
regardless of `NEXT_PUBLIC_APP_LOCALE`. Translating `messages/pt.json`
can't fix this: the text isn't rendered from a translation key, it's
composed once in SQL and written verbatim into `notifications.title`
/ `notifications.body` at insert time (migration
`027_notifications.sql`, function `notify_conversation_assigned()`,
lines ~90-103).

## Non-goals

- Per-user locale preference. The app is single-locale per deployment
  (`NEXT_PUBLIC_APP_LOCALE`, build-time) — this spec keeps that
  constraint, it doesn't add per-account/per-user language settings.
- Notification types beyond `conversation_assigned` (the only one that
  exists today). The design should make adding a second type easy,
  but adding one is out of scope here.
- Historical rows. Existing `notifications` rows keep their frozen
  English text — not worth a backfill for a notifications list that's
  inherently transient/recent.

## Current behavior

- `supabase/migrations/027_notifications.sql`: `notifications` table
  has `title TEXT`, `body TEXT` (freeform), plus structured columns
  already present for this exact purpose: `type`, `conversation_id`,
  `contact_id`, `actor_user_id`.
- The trigger `notify_conversation_assigned()` builds the English
  sentence in PL/pgSQL string concatenation and stores it.
- `src/app/(dashboard)/notifications/page.tsx` renders `n.title` and
  `n.body` directly (lines ~242, ~251-254) — no i18n involved at
  render time.

## Proposed change

Stop storing the final sentence. Store only what's needed to build it
client-side, then render via next-intl (which already has the
account's locale loaded):

1. Migration `044`: `CREATE OR REPLACE FUNCTION
   notify_conversation_assigned()` to stop writing `title`/`body`.
   Instead, keep writing the existing structured columns
   (`actor_user_id`, `contact_id`, `conversation_id`, `type`) — those
   already carry everything the sentence needs. `title`/`body` can go
   nullable-and-unused, or be dropped in a later cleanup migration —
   don't drop them in the same migration that stops writing them
   (matches this repo's own pattern of small, single-purpose
   migrations).
2. `src/app/(dashboard)/notifications/page.tsx`: when `n.type ===
   'conversation_assigned'`, look up `n.contact` (needs a join — the
   current query likely only selects `notifications.*`; check and add
   `contact:contacts(name, phone)` and `actor:profiles!actor_user_id(full_name)`
   to the select) and render via
   `t('assignedTitle')` / `t.rich('assignedBody', { actor, contact })`
   under a new `Notifications.types.conversationAssigned` key added to
   all four `messages/*.json` files. Fall back to the raw `n.title` /
   `n.body` for any row where the structured fields are missing (old
   rows from before this migration, or a future type not yet handled
   client-side) — same defensive pattern as `triggerLabel`/`stepLabel`
   added to the automation logs page.
3. Add the new message keys to `en.json`, `pt.json`, `es.json`,
   `ko.json` — `src/i18n/*.test.ts` will catch any locale left behind.

## Acceptance criteria

- [ ] A new `conversation_assigned` notification, created after this
      change ships, renders in the account's configured locale (test
      with `NEXT_PUBLIC_APP_LOCALE=pt`).
- [ ] A notification row from before this migration (frozen English
      `title`/`body`) still renders correctly (fallback path).
- [ ] `npm test` — `src/i18n/*.test.ts` passes for all four locales.
- [ ] `supabase/ci/verify-schema.sql` gets a check that
      `notify_conversation_assigned()` no longer contains the literal
      `'New conversation assigned'` string, mirroring the pattern used
      for migrations 041/043.

## Risks / open questions

- Confirm RLS on `contacts`/`profiles` lets the notification recipient
  read the joined `contact.name` / `actor.full_name` — the recipient
  is always an `is_account_member` of the same account the contact and
  actor belong to, so this should already be covered by the existing
  `contacts_select` / `profiles_select` policies, but verify before
  shipping.
