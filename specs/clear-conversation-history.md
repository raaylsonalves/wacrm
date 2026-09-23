# Spec: Clear conversation history

## Problem

There's no way to wipe a conversation's message history from the app.
Surfaced while testing the AI agenda tools (specs/ai-agenda-tool-
calling.md): old messages from an earlier, unrelated test persisted in
`buildConversationContext`'s window and visibly confused later replies
(the model echoed business context from a prior test). The only
current option is a fresh contact/conversation, which doesn't help
when you want to keep reusing the same test thread.

## Non-goals

- Deleting the conversation itself (contact, assignment, tags stay).
  Only `messages` rows are removed.
- A generic "delete conversation" or "block contact" feature — out of
  scope, this is specifically about clearing history in place.
- Undo — this is a hard delete, same as `contacts/[id]/anonymize`'s
  media removal. No trash/recovery.

## Current behavior

- `messages` RLS (migration 017) already permits DELETE to `agent+`
  via the `messages_modify` `FOR ALL` policy — but no UI or route
  exercises it today.
- `src/components/inbox/conversation-list.tsx`'s per-row context menu
  (lines ~900-1022) has status / assign / tag groups, each backed by a
  direct browser-client `supabase.from('conversations').update(...)`
  call (`handleRowStatusChange` etc., lines ~254-300) — no server route
  in the loop, because RLS's `agent+` bar already matches what the
  product wants for those actions.
- `conversations` has several fields the message-insert path
  denormalizes and nothing currently resets: `last_message_text`,
  `last_message_at`, `last_message_sender_type` (051), `unread_count`,
  plus the AI auto-reply fields `ai_reply_count` / `ai_autoreply_disabled`
  / `ai_handoff_summary` (029, 033).
- `src/lib/contacts/anonymize.ts`'s `parseStorageObjectUrl` is already
  generic (not contact-specific) — reusable for finding each deleted
  message's Storage object before the row goes away.

## Proposed change

Clearing history is stricter than the RLS floor (`agent+`) — same
reasoning as `canManageLgpd`: a hard, irreversible bulk delete belongs
above the routine-write bar. So, unlike status/assign, this goes
through a server route that enforces `admin+` regardless of what RLS
alone would allow a lower role to do via a raw REST call.

1. `src/lib/auth/roles.ts`: add `canClearConversationHistory(role)` →
   `hasMinRole(role, 'admin')`. `src/hooks/use-can.ts`: add the
   `'clear-conversation-history'` `CanAction`.
2. `DELETE /api/conversations/[id]/messages` (new route, mirrors
   `contacts/[id]/anonymize`'s shape):
   - `requireRole('admin')` + `RATE_LIMITS.adminAction`.
   - Confirm the conversation belongs to the caller's account
     (`.eq('account_id', ctx.accountId)`) before touching anything.
   - Collect `media_url` from every message in the conversation, parse
     with `parseStorageObjectUrl`, best-effort `.storage.from(bucket)
     .remove(paths)` (grouped by bucket, same pattern as anonymize) —
     a Storage failure logs and continues rather than blocking the
     delete.
   - `DELETE FROM messages WHERE conversation_id = :id`.
   - Reset the conversation's denormalized fields in the same request:
     `last_message_text: null, last_message_at: null,
     last_message_sender_type: null, unread_count: 0, ai_reply_count: 0,
     ai_autoreply_disabled: false, ai_handoff_summary: null`. Deliberately
     resets the AI fields too — a cleared thread should give the bot a
     fresh cap/handoff state, not stay paused from before.
3. UI: a new `ContextMenuItem` in `conversation-list.tsx`'s row menu,
   its own group below tags, gated by `useCan('clear-conversation-history')`
   so non-admins never see it. `window.confirm` before firing (same
   pattern as `contact-detail-view.tsx`'s anonymize button) — no new
   dialog component needed for a one-off confirm. On success, clears
   the row's local preview via the existing `onConversationsLoaded`/
   parent-state path (or a simple refetch) and closes the thread view
   if it's the currently open conversation.
4. i18n: `Inbox.conversationList.clearHistory` /
   `clearHistoryConfirm` / `clearHistorySuccess` / `clearHistoryFailed`,
   all 4 locales.

## Acceptance criteria

- [ ] A non-admin (agent/viewer) never sees the "Clear history" item.
- [ ] An admin clicking it, after confirming, ends up with zero rows
      in `messages` for that conversation; the conversation row itself
      and the contact are untouched.
- [ ] The conversation list preview and unread badge reset immediately
      after clearing (no stale "last message" text).
- [ ] The AI auto-reply cap/pause state resets — a conversation that
      was paused/handed off before clearing can auto-reply again.
- [ ] Any message media in that conversation is removed from Storage,
      best-effort (a Storage failure doesn't block the delete).
- [ ] A direct REST call as an `agent`-role user is rejected (403) even
      though the underlying RLS policy alone would technically allow
      the DELETE — the route's own role check is what's tested here,
      not RLS.

## Risks / open questions

- **No trash/undo**: same risk profile as anonymize's media removal —
  accepted, matches existing precedent in this codebase.
- **Realtime**: conversations subscribed via Postgres realtime will see
  the `messages` DELETE events and the `conversations` UPDATE — no new
  wiring needed if the inbox already reacts to those (it does, for the
  agenda feature's own realtime subscription pattern).
