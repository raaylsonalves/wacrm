# Spec: Responsible agents per WhatsApp channel

> Ported from deskcomm's `channel_routing_policies` /
> `channel_routing_responsibles` (`lib/routing/channel-policies.ts`,
> `app/api/v1/settings/routing/channels/route.ts`), confirmed via
> investigation of that repo. This is human-responsibility-to-number
> binding — restricting which agents a given number's conversations
> can be assigned to — NOT the AI-agent-to-number binding
> `specs/multi-agent-router.md` already covers (that one picks which
> AI agent answers; this one picks which humans are allowed to own
> the thread at all).

## Problem

wacrm has no concept of "this number is Sales, only Sales agents
should see/own its conversations." Today, any conversation — on the
Cloud API number or any WAHA channel — can be assigned to any account
member via the existing reassign flow
(`src/components/inbox/conversation-list.tsx`'s context menu,
`onAssignChange` → `PATCH .../assigned_agent_id`), with no
number-based restriction at all. An account running Sales on one
WAHA number and Support on another has no way to keep a Support agent
from being assigned a Sales conversation by mistake (or vice versa) —
the two are only visually distinguished by the channel badge added in
`specs/waha-channel-connection.md`'s follow-up work, never enforced.

## Non-goals

- **Restricting who can READ a conversation** — RLS already scopes
  every conversation to the account; this spec is about assignment
  eligibility, not visibility. A viewer/agent can still see a
  conversation on a number they're not "responsible" for; they just
  can't be assigned it (or assign it to someone ineligible).
- **Auto-assignment / round-robin among responsibles.** deskcomm's
  own policy is "restrict the eligible set," not "auto-pick from it."
  Automatic assignment (e.g. a Flow/automation step that assigns to
  "whoever's responsible, least busy") is a natural follow-up once
  this restriction exists, not part of this spec.
- **Per-number role overrides** (e.g. "this user is only an agent on
  channel A but admin on channel B"). Account role stays global
  (`src/lib/auth/roles.ts`) — this spec only gates the assignment
  target list, not permission tiers.

## Current behavior

- `whatsapp_waha_channels` (migration 056) has no responsibility
  concept — any admin+ can create/delete a channel, but nothing says
  who's meant to work its conversations day to day.
- Assignment: `src/app/api/v1/conversations/[id]/route.ts` and the
  dashboard's own `assigned_agent_id` updates
  (`conversation-list.tsx`, `message-thread.tsx`'s assign dropdown)
  both just check the target is a member of the account — no
  per-channel eligibility check exists anywhere in either path.
- The account-wide members list (`GET /api/account/members`) is what
  populates every "assign to" dropdown today — same list regardless
  of which channel the conversation is on.

## Proposed change

### 1. Schema — a policy row per channel, optional

```sql
-- migration 069 (or the next free number at implementation time)
CREATE TABLE channel_routing_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- One policy per channel; NULL waha_channel_id = the account's
  -- Cloud API number (mirrors the NULL-means-Cloud-API convention
  -- established in conversations.whatsapp_channel_id, migration 056).
  waha_channel_id uuid UNIQUE REFERENCES whatsapp_waha_channels(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- A separate UNIQUE constraint for the Cloud API (NULL) case — at
-- most one policy per account with waha_channel_id IS NULL:
CREATE UNIQUE INDEX idx_channel_routing_policies_cloud_api
  ON channel_routing_policies (account_id) WHERE waha_channel_id IS NULL;

CREATE TABLE channel_routing_responsibles (
  policy_id uuid NOT NULL REFERENCES channel_routing_policies(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  PRIMARY KEY (policy_id, user_id)
);
```

No policy row for a channel = unrestricted (every account member is
eligible) — mirrors deskcomm's `legacy_unconfigured` mode exactly, so
an account that never touches this feature sees zero behavior change.
A policy row with zero `channel_routing_responsibles` rows = nobody
eligible ("restricted_empty" in deskcomm's own naming) — an explicit
"this number has no owner yet" state, distinct from "unrestricted."

### 2. Enforcement point — one shared resolver, both call sites

`src/lib/channels/routing.ts`:

```ts
export async function eligibleAssigneesForConversation(
  db: SupabaseClient,
  accountId: string,
  whatsappChannelId: string | null,
): Promise<string[] | null> {
  // null return = unrestricted (every account member).
  // A non-null empty array = restricted_empty (nobody eligible yet).
}
```

Called from both places that currently just check account membership:
`src/app/api/v1/conversations/[id]/route.ts`'s assignment PATCH, and
the dashboard's direct `assigned_agent_id` update in
`conversation-list.tsx`/`message-thread.tsx` (via a new lightweight
`GET /api/conversations/[id]/eligible-assignees` the assign dropdown
calls to populate its own options, rather than the account-wide
members list). Reject an assignment to an ineligible user with the
same 400-class error shape `handoff_agent_id`'s existing membership
check already uses in `/api/ai/config`.

### 3. UI

- New Settings panel, `Settings → Canais → Responsáveis` (fits the
  grouped-navigation "Canais" section from `specs/grouped-navigation.md`)
  — one row per channel (including "API Oficial" for the Cloud API
  slot), a multi-select of account members, empty = unrestricted.
- Assign dropdowns (inbox context menu, thread header) filter their
  member list through `eligibleAssigneesForConversation` — an
  ineligible member simply doesn't appear as an option, rather than
  appearing and then erroring on selection.

## Acceptance criteria

- [ ] An account that never configures a policy sees zero behavior
      change — every member is still assignable to every conversation.
- [ ] Configuring a policy for a WAHA channel with 2 responsibles
      means only those 2 appear in that channel's conversations'
      assign dropdown; a 3rd member can't be assigned via the API
      either, even by forging the request.
- [ ] A policy with zero responsibles ("restricted_empty") shows a
      distinct "no one is responsible for this channel yet" state in
      the assign UI, not an empty dropdown that looks broken.
- [ ] Removing a channel (`DELETE /api/whatsapp/waha/channels/[id]`)
      cascades its policy/responsibles rows away cleanly (FK
      `ON DELETE CASCADE`) — no orphaned policy referencing a deleted
      channel.

## Risks / open questions

- **Existing assignments on a conversation that becomes restricted
  after the fact.** If a conversation is already assigned to someone
  who then gets excluded from a newly-configured policy, does the
  existing assignment stay (grandfathered) or get force-unassigned?
  Recommend grandfathering — matches deskcomm's own framing of this as
  restricting future assignment eligibility, not retroactively
  auditing existing ones.
- **Interaction with `specs/multi-agent-router.md`'s AI routing.** The
  two features are independent (human responsibility vs. AI agent
  selection) but both key off the same channel concept — worth a
  single combined "Canal" settings sub-page presenting both once both
  exist, rather than two separate screens that both mention the same
  channel list.
