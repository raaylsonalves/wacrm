# Spec: Right-click context menu for inbox messages and contacts

**Status: partially implemented.** The conversation-list row menu (item 2
of the proposed change — "the highest-value net-new surface since none of
these exist as row-level actions today") is done:
`src/components/ui/context-menu.tsx` wraps `@base-ui/react`'s
`ContextMenu` primitive (same shadcn-style pattern as `dropdown-menu.tsx`);
`src/components/inbox/conversation-list.tsx` right-click opens a menu with
status change, assign/unassign, and tag toggle, reusing the exact
`Inbox.messageThread` translation keys the thread header's own dropdowns
use. Status/assign write straight to `conversations` (mirroring
`MessageThread`'s `handleStatusChange`/`handleAssignChange`); tags go
through the existing `/api/contacts/[id]/tags` route. New optional
`onStatusChange`/`onAssignChange`/`onContactTagsChange` props on
`ConversationList`, wired in `inbox/page.tsx` to the same state-patch
handlers `MessageThread` already used, plus a new `handleContactTagsChange`
for the tag case. Verified live: right-click → change status → change
tags, confirmed via direct SQL that writes landed and reverted correctly.

**Not implemented:** message-bubble right-click (item 1) — the hover
toolbar remains the only path to message actions (reply/react/copy/
forward/delete). Left for a follow-up since it's lower-value per the
spec's own "Proposed change" ordering and touches the existing touch
long-press `contextmenu` handler in `message-actions.tsx`, which needs
its own careful regression check.

## Problem

The inbox only exposes actions (reply, react, delete, forward, copy,
assign, tag, …) through a hover toolbar and dropdown menus. There's no
right-click ("context menu") shortcut, which power users doing bulk
triage expect from any desktop messaging UI (compare Slack, WhatsApp
Desktop, Gmail).

## Non-goals

- A generic "context menu" primitive used app-wide. Scope this to the
  two places it matters most: the message list (`message-bubble.tsx`)
  and the conversation list (`conversation-list.tsx`). Extending to
  contacts/deals tables is a natural follow-up, not this spec.
- Touch/mobile — long-press-for-context-menu is a separate interaction
  pattern; `message-actions.tsx` already has a long-press `contextmenu`
  handler for touch devices (see Current behavior) that this spec
  should not regress.

## Current behavior

- `src/components/inbox/message-actions.tsx` (~line 39-88): already
  listens for the native `contextmenu` event, but only as a **touch
  long-press proxy** — the comment says "Touch devices have no hover.
  Long-press fires `contextmenu`; we capture [it]" — i.e. it exists to
  detect a mobile long-press, not to open a desktop right-click menu.
  On a real right-click (mouse), this same handler almost certainly
  fires too, but check what `handleContextMenu` actually does before
  assuming — it may currently just replicate the hover-toolbar tap
  target rather than opening a menu.
- Desktop message actions today live in a hover-revealed toolbar
  (`MessageActions`) — reply, react, copy, delete, forward — each its
  own button, not a consolidated menu.
- The conversation list (`src/components/inbox/conversation-list.tsx`)
  has no per-row hover/right-click actions at all today — status
  change, assign, tag, archive/delete all require opening the
  conversation first.

## Proposed change

1. Message bubbles: on desktop (pointer: fine), a real right-click
   (`e.preventDefault()` + `e.button === 2`, or Radix/base-ui's
   `ContextMenu` primitive — the codebase already uses shadcn-style
   `@base-ui/react` components, check if a context-menu primitive
   ships with it) opens a menu with the same actions the hover toolbar
   exposes today (reply, react, copy text, forward, delete — gated by
   the same permission checks `MessageActions` already applies), so
   there is exactly one source of truth for "what actions can I take
   on this message," not two divergent lists.
2. Conversation list rows: add a right-click menu for status change
   (open/pending/closed — reuse `STATUS_OPTIONS` from
   `message-thread.tsx`), assign to agent, and tag — without requiring
   the conversation to be open first. This is the highest-value net-new
   surface since none of these exist as row-level actions today.
3. Keep the existing long-press-for-touch behavior in
   `message-actions.tsx` working unchanged — a real right-click on
   desktop and a long-press on touch should both resolve to "open this
   same menu," not diverge into two different interactions.

## Acceptance criteria

- [ ] Right-clicking a message bubble on desktop opens a menu (not the
      browser's native context menu) with the same actions available
      via the hover toolbar, respecting the same role/permission gates.
- [ ] Right-clicking a conversation-list row opens a menu with at least
      status change, assign, and tag actions, without navigating into
      the conversation.
- [ ] Existing touch long-press behavior in `message-actions.tsx` is
      unchanged (regression check, not just "doesn't crash").
- [ ] Keyboard-only users retain an equivalent path to every action
      newly exposed here (a context menu shouldn't be the *only* way to
      reach a mutation — check against `useCan`/role gates already used
      elsewhere for consistency).

## Risks / open questions

- Confirm whether `@base-ui/react` (already a dependency per
  `CLAUDE.md`) ships a context-menu primitive, or whether this needs a
  new small dependency / hand-rolled positioned-popover component.
- Decide the interaction when a message is selected for bulk actions
  (if that exists or is planned) — does right-click act on just the
  clicked message, or the whole selection?
