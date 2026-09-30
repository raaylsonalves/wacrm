# Spec: Schedule a broadcast for a specific date/time

**Status: implemented (2026-09-30).** Wizard "Agora / Agendar" (`step4-schedule-send.tsx`, rules in `lib/whatsapp/broadcast-schedule-rules.ts`), migration 087 (`cancelled` status + due index), cron drain `runScheduledBroadcasts` in `/api/automations/cron` reusing `planBroadcastResume` + `deliverBroadcast`, opt-outs re-checked at fire time, cancel on the detail page. Not done: send window, pause/resume, and media-header URL overrides for scheduled sends (the template's stored URL is used).

## Problem

An account can only send a broadcast immediately — there's no way to
compose one now and have it fire at, say, 9am tomorrow. This is a real
gap, not a missing nice-to-have: the schema already has a
`scheduled_at` column and a `'scheduled'` status
(`broadcasts.status CHECK (... IN ('draft', 'scheduled', 'sending',
'sent', 'failed'))`, migration 001) that nothing in the application
ever reads or writes — the feature was half-modeled at the schema
level and never finished.

## Non-goals

- Recurring/repeating broadcasts (send every Monday at 9am) — this is
  a one-time future send only. A recurring schedule is a meaningfully
  different feature (needs its own "series" concept, pause/skip-once
  semantics) and deserves its own spec if wanted later.
- Timezone-per-recipient delivery (send at 9am in *each contact's*
  timezone) — schedule a single instant for the whole broadcast,
  interpreted in the account's own timezone/UTC. Per-recipient
  timezone-aware delivery is a substantially harder problem (contacts
  have no stored timezone today) and out of scope.
- Editing a scheduled broadcast's audience/template after scheduling —
  out of scope for a first pass; canceling and recreating is
  sufficient until there's demand for in-place edits.

## Current behavior

- `broadcasts.scheduled_at` / `.status` (migration 001): present in
  the schema and on the `Broadcast` type (`src/types/index.ts`), but
  no code path ever sets `scheduled_at` to a non-null value, and no
  code ever reads `status = 'scheduled'`.
- `src/components/broadcasts/step4-schedule-send.tsx`: despite the
  name, this is an immediate-send confirmation step (name it, see the
  estimated reach, confirm, watch a progress bar) with a "Save draft"
  option — no date/time picker anywhere in the wizard.
- `src/lib/whatsapp/broadcast-core.ts`: `createBroadcast()` creates the
  parent row + recipients (migration 037's atomic RPC, per `CLAUDE.md`),
  `deliverBroadcast()` sends to each recipient and updates per-status
  counts, `finalizeBroadcastStatus()` closes it out. All three assume
  they're being called synchronously, right now, from the wizard's
  submit handler (`src/app/(dashboard)/broadcasts/new/page.tsx`).
- The automations engine already solved the closely-related "durable
  future action" problem for its own `Wait` step:
  `automation_pending_executions` (a row with a `run_at` timestamp) is
  drained by `GET /api/automations/cron`
  (`src/app/api/automations/cron/route.ts`) — a shared-secret-gated
  endpoint meant to be hit on a schedule (Vercel Cron or an external
  pinger), with a claim-based lock (`status = 'running'`) so
  overlapping invocations can't double-process a row, and stale-lock
  reclaim if a process dies mid-run. This is the pattern to reuse
  rather than inventing a second scheduling mechanism.

## Proposed change

1. **Wizard**: add an actual date/time picker to
   `step4-schedule-send.tsx` — "Send now" (today's behavior, unchanged)
   vs. "Schedule for later" with a datetime input. Reject a past
   datetime client-side before submit.
2. **Create path**: when scheduled, `createBroadcast()` sets
   `scheduled_at` to the chosen instant and `status = 'scheduled'`
   instead of immediately calling `deliverBroadcast()`. The recipient
   rows still get created up front (same atomic RPC, so a scheduled
   broadcast has the same "audience frozen at creation time" semantics
   an immediate one already has — a contact added to a tag after
   scheduling doesn't retroactively join the audience).
3. **Cron drain**: new `GET /api/broadcasts/cron`, structurally a copy
   of `automations/cron/route.ts` — same shared-secret auth pattern
   (a new `BROADCAST_CRON_SECRET`, or reuse `AUTOMATION_CRON_SECRET` if
   the account owner is fine sharing one secret across both crons),
   same claim-then-process-then-finalize shape: claim due
   (`scheduled_at <= now()`, `status = 'scheduled'`) broadcasts by
   flipping to `'sending'`, call the existing `deliverBroadcast()` +
   `finalizeBroadcastStatus()` for each, with the same stale-`'sending'`
   reclaim window `automations/cron` uses for its stale-`'running'`
   case (a broadcast stuck mid-send from a killed process shouldn't be
   stuck forever).
4. **Cancel**: a "Cancel" action on a `'scheduled'` broadcast (list/
   detail page) flips it back to `'draft'` (or deletes it, if a draft
   with a frozen recipient list isn't a state worth keeping) before its
   `scheduled_at` arrives. Once claimed (`status = 'sending'`), it's
   past the point of no return, same as an immediate send today.
5. **UI**: the broadcasts list (`src/app/(dashboard)/broadcasts/page.tsx`
   if it exists in that shape — confirm) should show `'scheduled'`
   broadcasts with their target time, distinct from `'draft'`/`'sent'`.

## Update (2026-09-29): still unimplemented; additions after comparing with deskcomm

Re-verified against the code: `scheduled_at` and `status = 'scheduled'`
(migration 001) are still never written or read (`grep scheduled_at` in
`src/` finds only the type). The user confirmed the gap from the UI
("nos disparos ainda não tem schedule"). What has changed since this spec
was written, and what to add:

- **Broadcasts can now send via WAHA, with channel rotation**
  (`broadcasts.primary_channel_id`, `broadcast_channel_pool`, migrations
  068). A scheduled broadcast must persist those at creation (it already
  does — `createBroadcast` takes them) and the cron drain must resume it
  through `planBroadcastResume` (`broadcast-resume.ts`), which already
  understands the WAHA branch. Do **not** hand-roll a second delivery
  path in the cron route.
- **Pause / resume**, from deskcomm's campaign state machine
  (`lib/campanhas/maquina-de-estados.ts`: `draft → ready → scheduled →
  running ⇄ paused → completed`, with `cancelled` reachable from every
  non-terminal state — deskcomm learned in production that a prepared
  campaign that *shouldn't* go out must be cancellable before it starts).
  wacrm's `status` CHECK lacks `paused`/`cancelled`; extend it (text +
  CHECK, additive) and keep the transition table in one pure module the
  routes call before writing status.
- **Sending window** (`send_window: {start_hour, end_hour, tz}` on the
  broadcast, optional): when the cron finds a due broadcast outside its
  window, leave it `scheduled` for the next window instead of sending at
  night. deskcomm keeps the *number's* protection (interval, window, daily
  cap) in one place (`channel_knobs`) and lets a campaign only be slower
  than the number — for wacrm the number-level knob is the WAHA throttle
  (`claim_waha_send_slot`), which already applies.
- **Consent gate** from `specs/prospecting-csv-import.md`: the audience
  resolver (used at schedule time *and* again when the cron fires, since
  contacts can opt out in between) must drop `opted_out_at` contacts and
  `third_party_list` contacts. Re-evaluating at fire time is the important
  part — an audience frozen days ago is stale on opt-outs.
- **Cron host**: fold the drain into the existing
  `GET /api/automations/cron` (as `followup-sequences.md` does) so no new
  external pinger is needed; keep the claim-then-process shape below.

## Acceptance criteria

- [ ] From the wizard, scheduling a broadcast for a future time creates
      a `'scheduled'` row with recipients already attached, and sends
      nothing immediately.
- [ ] The cron endpoint, hit after the scheduled time passes, delivers
      the broadcast exactly once — verified by hitting it twice in a
      row and confirming the second call is a no-op for that broadcast
      (mirrors `automations/cron`'s overlap-safety requirement).
- [ ] A scheduled broadcast can be canceled before it fires; a canceled
      broadcast never sends.
- [ ] `npm test` — new coverage for the cron endpoint's claim logic,
      following the shape of whatever tests (if any) cover
      `automations/cron`'s claim/reclaim behavior.

## Risks / open questions

- **Cron cadence**: how often is `/api/automations/cron` actually
  invoked today (Vercel Cron's minimum interval, or an external
  pinger's configured frequency)? A broadcast's "9:00am" could
  effectively mean "9:00–9:05am" depending on that cadence — confirm
  the existing interval and decide if that's acceptable, or if
  broadcasts need a tighter one.
- **Shared vs. separate cron secret**: reusing `AUTOMATION_CRON_SECRET`
  is less setup for a self-hosted fork but means rotating one secret
  affects both crons. Minor either way — flagged so it's a deliberate
  choice, not an accident.
- Confirm `src/app/(dashboard)/broadcasts/page.tsx` (or wherever the
  broadcast list actually lives) before implementing step 5 — this
  spec's Current Behavior section didn't audit the list view itself,
  only the creation wizard and the core send library.
