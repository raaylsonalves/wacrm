# Spec: Broadcast sends via WAHA, with channel rotation

> Ported from a real deskcomm feature (`campaign_channel_sessions` /
> `campaign_recipients.channel_session_id`, migration
> `20260921060200_0377_campanha_rodizio_de_numeros.sql`), confirmed via
> investigation of that repo. Adapted to wacrm's narrower/additive WAHA
> schema (`whatsapp_waha_channels`, not deskcomm's unified
> `channel_sessions`) — see `specs/waha-channel-connection.md` for why
> that split exists.

## Problem

Broadcast in wacrm only ever sends through the account's Cloud API
number (`src/lib/whatsapp/broadcast-core.ts`'s `createBroadcast`/
`deliverBroadcast` load `whatsapp_config` and call `sendTemplateMessage`
— nothing there even looks at `whatsapp_waha_channels`). An account
that connected WAHA channels (`specs/waha-channel-connection.md`) has
no way to broadcast from them at all, and an account with several
numbers (Cloud API + N WAHA channels) has no way to spread a large
broadcast's send volume across them — every recipient goes out from
the same one number, at that number's own throttle/rate-limit budget.

deskcomm's anti-ban doctrine treats this as load-bearing: WAHA numbers
that blast a campaign from a single number look exactly like spam to
WhatsApp. Rotating a campaign across a small pool of numbers — "the
one with the most headroom sends next" — is the mitigation they ship,
distinct from (and complementary to) the per-send throttle wacrm
already has (`specs/waha-anti-banimento-e-opt-out.md`,
`claim_waha_send_slot`).

## Non-goals

- **Cross-provider rotation in one campaign** (some recipients via
  Cloud API, others via WAHA, in the same broadcast). Non-goal for v1
  — a broadcast's rotation pool is same-provider only: either the
  account's one Cloud API number, or a chosen subset of its WAHA
  channels. Picking a WAHA channel per-recipient inside a
  Cloud-API-primary broadcast isn't how deskcomm does it either
  (`campaigns.channel_session_id` stays the one required primary; the
  pool is additive numbers of the SAME kind).
- **Automatic pool sizing / suggesting how many numbers to add.** The
  account picks which of its existing WAHA channels join a campaign's
  pool; this spec doesn't add capacity-planning UI.
- **Rotating automations/Flows sends.** Those still go out through
  whichever single channel each already resolves to
  (`whatsapp_config` for Cloud API, or a specific WAHA channel for a
  WAHA-scoped conversation reply) — a broadcast is a deliberate bulk
  blast to many contacts, which is the actual anti-ban risk case; a
  Flow/automation reply is one contact, one existing conversation, and
  doesn't need pooling.

## Current behavior

- `src/lib/whatsapp/broadcast-core.ts`: `createBroadcast()` reads one
  `whatsapp_config` row (`.eq('account_id', accountId).single()`,
  around line 113) and hard-fails if it's missing — an account with
  only WAHA channels connected can't broadcast at all today.
  `deliverBroadcast()` calls `sendTemplateMessage` (Cloud API-only
  adapter) per recipient.
- `broadcast_recipients` (migrations 003/005) has no channel column —
  there's nothing to record "which number actually sent this one."
- `src/lib/whatsapp/waha-api.ts`'s `sendWahaText` only supports plain
  text (no template concept for WAHA — see
  `specs/waha-channel-connection.md`'s own scoping), so a WAHA-routed
  broadcast can't reuse the Cloud-API template flow verbatim; it needs
  its own send path, same as `send-message.ts`'s
  `if (conversation.whatsapp_channel_id) { ...waha... } else { ...cloud... }`
  split.
- `claim_waha_send_slot` (migration 064) already throttles any single
  WAHA channel's send rate — this spec's rotation pool is what decides
  WHICH channel gets asked to claim a slot next, not a replacement for
  the claim itself.

## Proposed change

### 1. Schema — a pool table + a per-recipient record of what was used

```sql
-- migration 068 (or the next free number at implementation time)
CREATE TABLE broadcast_channel_pool (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  broadcast_id uuid NOT NULL REFERENCES broadcasts(id) ON DELETE CASCADE,
  waha_channel_id uuid NOT NULL REFERENCES whatsapp_waha_channels(id) ON DELETE CASCADE,
  UNIQUE (broadcast_id, waha_channel_id)
);

ALTER TABLE broadcast_recipients
  ADD COLUMN IF NOT EXISTS sent_via_channel_id uuid
    REFERENCES whatsapp_waha_channels(id) ON DELETE SET NULL;
  -- NULL = sent via the account's Cloud API number (today's only
  -- path) — same "NULL means Cloud API" convention `conversations.
  -- whatsapp_channel_id` already established (migration 056).
```

`broadcasts` itself needs one more column to record the PRIMARY
channel a WAHA-based broadcast is anchored to (mirrors deskcomm's
`campaigns.channel_session_id` staying required):

```sql
ALTER TABLE broadcasts
  ADD COLUMN IF NOT EXISTS primary_channel_id uuid
    REFERENCES whatsapp_waha_channels(id) ON DELETE SET NULL;
  -- NULL = Cloud API broadcast (unchanged, today's only mode).
```

A broadcast with a `primary_channel_id` set is a WAHA broadcast, whose
rotation pool (`broadcast_channel_pool`) may list zero or more
additional WAHA channels; zero rows in the pool = send only from the
one primary channel, no rotation (the simple case, opt-in complexity).

### 2. Rotation policy — least-recently-used, not round-robin

"The one with the most headroom sends next" (deskcomm's own framing)
maps cleanly onto `whatsapp_waha_channels.last_sent_at` (migration
064, already the throttle's own bookkeeping column): picking the pool
member with the OLDEST `last_sent_at` for each next recipient is
exactly "most headroom" — no new column needed, this is the same
signal `claim_waha_send_slot` already reads.

```ts
// src/lib/whatsapp/broadcast-rotation.ts
export async function pickNextChannel(
  db: SupabaseClient,
  broadcastId: string,
): Promise<string> {
  // primary + pool, ordered by last_sent_at ascending (NULLS FIRST —
  // a never-sent channel has the most headroom of all).
}
```

Called once per recipient inside `deliverBroadcast`'s existing loop,
immediately before that recipient's send — NOT precomputed for the
whole batch, so a channel that fails mid-broadcast (WAHA session
drops) naturally gets skipped less often as its `last_sent_at` stops
advancing... no — inverted: a channel that stops succeeding still
looks "most idle" and gets picked MORE, not less. Needs a real
per-channel failure count or a short cooldown after N consecutive
failures — flagged as an open question below, not solved by
`last_sent_at` alone.

### 3. Send path — branch like `send-message.ts` already does

`deliverBroadcast` gains the same shape `send-message.ts` uses:

```ts
if (broadcast.primary_channel_id) {
  const channelId = await pickNextChannel(db, broadcast.id);
  await claimWahaSendSlot(channelId, { isBroadcast: true, connectedAt });
  const result = await sendWahaText(...);
  // stamp broadcast_recipients.sent_via_channel_id = channelId
} else {
  // unchanged Cloud API path
}
```

WAHA has no template mechanism (spec's own non-goal in
`waha-channel-connection.md`), so a WAHA broadcast sends the
template's already-rendered body text as a plain WAHA message — the
UI must make this limitation visible at compose time (a WAHA
broadcast can't use header images/buttons a Cloud API template might
have; degrade to body text only, same restriction
`send-message.ts`'s WAHA branch already applies to manual sends).

### 4. UI — compose step gains a channel picker

`src/components/broadcasts/*` (the compose wizard) gains: a "Send
from" selector (Cloud API vs. one of the account's WAHA channels as
primary), and when a WAHA channel is chosen, a multi-select of
additional WAHA channels to pool. Recipient results table gains a
"Sent via" column (channel label, or "Cloud API").

## Acceptance criteria

- [ ] An account with only WAHA channels (no Cloud API config) can
      create and send a broadcast — today this is a hard failure.
- [ ] A broadcast with a rotation pool of 3 WAHA channels distributes
      recipients across all 3, not just the primary.
- [ ] `broadcast_recipients.sent_via_channel_id` correctly records
      which channel sent each message; the results UI shows it.
- [ ] Each pooled channel's send still respects `claim_waha_send_slot`
      — rotation picks WHICH channel to ask, the existing throttle
      still gates WHETHER that channel can send right now.
- [ ] A Cloud API broadcast (no `primary_channel_id`) behaves
      byte-for-byte identically to today — this is additive.

## Risks / open questions

- **Failure handling in rotation** (flagged above): `last_sent_at`
  alone can't tell a healthy-but-idle channel apart from a
  broken-and-not-sending one. Needs either a short per-channel
  cooldown after N consecutive failures, or excluding a channel
  whose `status <> 'connected'` from the pool at pick time (the
  latter is simpler and reuses a column that already exists).
- **Recipient-to-channel affinity across a resumed broadcast.** If a
  broadcast pauses/resumes (existing `resume` route), should the same
  contact always get the same channel on retry, or can it flip?
  deskcomm's own schema suggests "recorded at send time, not
  reserved in advance" — a retry can pick a different channel. Confirm
  this doesn't confuse a contact who sees a different sender number on
  a retried message.
- **Per-extra-channel billing** intersects here too (see the note
  added to `specs/billing-subscriptions.md`) — if extra WAHA channels
  become a paid add-on later, a broadcast pool is exactly the kind of
  usage that add-on would be justifying.
