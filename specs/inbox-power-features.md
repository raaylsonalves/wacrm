# Spec: Inbox power features (snooze, conversation tags, internal notes, keyboard shortcuts)

**Status (2026-09-30): implemented (snooze, conversation tags, internal notes — migration 070 — and keyboard shortcuts).**

> Four small, independent features spotted during an investigation of
> deskcomm's Inbox (`components/inbox/*`) that wacrm's Inbox doesn't
> have. Bundled into one spec because each is small enough that a
> separate spec per feature would be more overhead than the features
> themselves — but each is independently shippable and none depends
> on another; implement in any order, or drop any one without
> affecting the rest.

## Problem

Comparing wacrm's Inbox (`src/components/inbox/`) against deskcomm's
(`components/inbox/` there) surfaced four real gaps:

1. **No snooze.** A conversation an agent isn't ready to act on yet
   (waiting on internal info, following up tomorrow) has no way to
   get out of the active list temporarily — the only states are
   `open`/`pending`/`closed` (permanent-ish), forcing an agent to
   either leave it cluttering the open list or close it (losing the
   "still needs a reply" signal).
2. **Tags exist only on contacts, not conversations.** `contact_tags`
   (migration 001) tags the PERSON — every conversation that contact
   ever has inherits the same tags forever. deskcomm keeps a separate
   conversation-level tag system precisely because a tag like
   "needs follow-up" or "escalated" describes THIS thread, not the
   contact permanently.
3. **No internal notes.** There's nowhere to leave a note on a
   conversation visible only to teammates ("customer already refunded
   via Stripe, don't offer another") — today that information either
   goes in a reply the customer sees, or nowhere.
4. **No keyboard shortcuts.** Power users triaging a busy queue have
   no way to navigate/act without reaching for the mouse on every row.

## Non-goals

- **Snooze auto-reopen scheduling beyond a fixed set of presets.**
  v1 offers a short list (1h / 3h / tomorrow 9am / custom date) —
  arbitrary recurring snoozes are a follow-up, not this spec.
- **Rich text / attachments in internal notes.** Plain text only,
  same trust level as a quick internal comment, not a second chat
  thread.
- **A full command palette.** Keyboard shortcuts here are direct
  single/two-key bindings for common actions (next/prev conversation,
  reply focus, archive, snooze) — not a searchable `⌘K`-style palette.
- **Conversation tags replacing contact tags.** Both coexist — contact
  tags describe the person across all their conversations (already
  used by Broadcast audience filtering, `use-broadcast-sending.ts`);
  conversation tags describe one thread. Migrating existing contact-
  tag usage isn't in scope.

## Current behavior

- `conversations` (migration 001+) has `status`
  (`open`/`pending`/`closed`) and `assigned_agent_id` — no `snoozed_
  until` or equivalent.
- `contact_tags` (migration 001, account-scoped via migration 017)
  is the only tag system; `src/components/inbox/conversation-list.tsx`'s
  tag filter dropdown and context-menu tag toggle
  (`handleRowToggleTag`) both operate on it.
- No notes table anywhere; `messages` has no `internal`/`visibility`
  flag to distinguish a note from a real WhatsApp message.
- No keyboard event handling exists in `src/components/inbox/*` —
  confirmed no `keydown`/`onKeyDown` listener at the conversation-list
  or thread level (the message composer's own Enter-to-send is the
  only keyboard handling in the whole Inbox).

## Proposed change

### 1. Snooze

```sql
-- migration 070 (or the next free number)
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS snoozed_until timestamptz;
CREATE INDEX IF NOT EXISTS idx_conversations_snoozed_until
  ON conversations (snoozed_until) WHERE snoozed_until IS NOT NULL;
```

- A snoozed conversation is filtered OUT of the default Inbox view
  (same list, an added `WHERE snoozed_until IS NULL OR snoozed_until <= now()`
  clause in `conversation-list.tsx`'s query) until the timestamp
  passes — no new status value, `status` stays orthogonal.
- Reopening: a cron-free approach works here (unlike automations'
  `Wait` steps) — the filter clause above means an expired snooze
  simply stops being filtered on the NEXT list load; no background
  job needed to "wake it up."
- A new inbound message on a snoozed conversation clears
  `snoozed_until` immediately (a customer replying is exactly the
  signal snoozing was waiting for) — hook into the same webhook path
  that already bumps `last_message_at`.
- UI: a "Snooze" action in the existing context menu
  (`ConversationItem`'s `ContextMenu` in `conversation-list.tsx`,
  alongside the existing Status/Assign/Tags groups) with the preset
  list from Non-goals.

### 2. Conversation-level tags

```sql
CREATE TABLE conversation_tags (
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  tag_id uuid NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (conversation_id, tag_id)
);
```

Reuses the existing `tags` table (migration 001, account-scoped) —
one tag vocabulary, two attachment points (`contact_tags` /
`conversation_tags`), same as deskcomm keeps them as two separate
join tables against one tag catalog. RLS mirrors `contact_tags`'
existing account-scoped policy. UI: the context menu's existing Tags
group grows a second section ("Tags da conversa" vs. today's
contact-tag section), and the conversation row shows both (contact
tags already render; conversation tags render alongside, visually
distinct — e.g. a small icon prefix — so an agent can tell which is
which at a glance).

### 3. Internal notes

```sql
CREATE TABLE conversation_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  author_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
```

A separate table, NOT a `messages` row with an `internal` flag —
keeps the customer-visible message history and internal commentary
structurally impossible to conflate (no risk of an internal note ever
rendering in a customer-facing view by a missed filter). RLS:
account-scoped read/write, same shape as `audit_log`'s SELECT policy
(any member reads; unlike audit_log, authenticated users CAN insert —
this is a normal collaborative note, not a tamper-evident log). UI:
a "Notes" tab or collapsible section in `ContactSidebar` (or a new
small panel in the thread view) — chronological list + a compose box,
visually distinct from the message thread (e.g. a yellow/amber note
card style, matching the visual language `PassagemCard`-equivalent
markers already use for non-message events in deskcomm).

### 4. Keyboard shortcuts

A small set, scoped to when the Inbox has focus and no text input is
focused (checked the same way the composer's own Enter-to-send avoids
firing during IME composition):

| Key | Action |
|---|---|
| `j` / `k` or `↓` / `↑` | Next / previous conversation in the list |
| `e` | Archive / close current conversation |
| `r` | Focus the reply composer |
| `s` | Open the snooze menu for the current conversation |
| `?` | Show a shortcuts help dialog |

Implemented as one hook, `src/hooks/use-inbox-shortcuts.ts`, mounted
once in the Inbox page — mirrors deskcomm's own split of
`InboxKeyboardShortcuts.tsx` (the listener) +
`ShortcutsHelpDialog.tsx` (the `?` dialog), which is a reasonable
separation to copy rather than invent fresh.

## Acceptance criteria

- [ ] Snoozing a conversation removes it from the default list
      immediately; it reappears on its own once `snoozed_until`
      passes, with no manual refresh or cron needed.
- [ ] A new inbound message on a snoozed conversation un-snoozes it
      immediately.
- [ ] A conversation can carry tags independent of its contact's tags;
      removing a conversation tag never touches the contact's tags
      and vice versa.
- [ ] An internal note never appears in the customer-facing message
      thread, under any view.
- [ ] `j`/`k`/arrow navigation moves the active conversation without
      the mouse; typing in the composer or a text input never
      triggers a shortcut.
- [ ] All four features are additive — an account that ignores all of
      them sees no change to today's Inbox behavior.

## Risks / open questions

- **Snooze vs. status interaction**: should snoozing a `closed`
  conversation do anything (there's nothing to "wake up" into since
  it's not in the active queue)? Recommend restricting the snooze
  action to `open`/`pending` conversations only, disabled for
  `closed` ones.
- **Conversation tags and Broadcast audience filtering**: `contact_tags`
  already feeds Broadcast's audience filter
  (`use-broadcast-sending.ts`). Confirm conversation tags are
  deliberately NOT wired into that filter (a broadcast targets
  people, not specific past conversations) before anyone assumes
  otherwise.
- **i18n volume**: four features' worth of new UI strings across
  `messages/*.json` (4 locales) — budget translation time alongside
  implementation, same note `signup-onboarding-wizard.md` made for
  its own multi-screen volume.
