-- ============================================================
-- 070_inbox_power_features.sql — snooze, conversation-level tags,
-- internal notes (specs/inbox-power-features.md). Keyboard shortcuts
-- need no schema.
--
-- All three are additive: an account that never snoozes, tags a
-- conversation or writes a note sees no change.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ---- 1. Snooze ----------------------------------------------------
-- No new status value — `status` stays orthogonal. The inbox filters
-- `snoozed_until IS NULL OR snoozed_until <= now()`, so an expired
-- snooze reappears on the next list load with no cron.
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS snoozed_until timestamptz;
CREATE INDEX IF NOT EXISTS idx_conversations_snoozed_until
  ON conversations (snoozed_until) WHERE snoozed_until IS NOT NULL;

-- A customer replying is exactly what a snooze was waiting for —
-- clear it in the one function both inbound webhooks (Meta and WAHA)
-- already call. Same body as migration 051 plus `snoozed_until`.
CREATE OR REPLACE FUNCTION public.bump_conversation_on_inbound(
  p_conversation_id UUID,
  p_last_message_text TEXT
)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE conversations
  SET unread_count              = COALESCE(unread_count, 0) + 1,
      last_message_text         = p_last_message_text,
      last_message_at           = NOW(),
      last_message_sender_type  = 'customer',
      snoozed_until             = NULL,
      updated_at                = NOW()
  WHERE id = p_conversation_id;
$$;

-- ---- 2. Conversation-level tags -----------------------------------
-- One tag vocabulary (`tags`), two attachment points. Deliberately NOT
-- wired into Broadcast audience filtering — a broadcast targets
-- people (contact_tags), not past threads.
CREATE TABLE IF NOT EXISTS conversation_tags (
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  tag_id uuid NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, tag_id)
);
CREATE INDEX IF NOT EXISTS idx_conversation_tags_tag ON conversation_tags(tag_id);

ALTER TABLE conversation_tags ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS conversation_tags_select ON conversation_tags;
CREATE POLICY conversation_tags_select ON conversation_tags FOR SELECT USING (
  EXISTS (SELECT 1 FROM conversations c
          WHERE c.id = conversation_tags.conversation_id
            AND is_account_member(c.account_id))
);
-- The WITH CHECK also pins the tag to the conversation's account, so a
-- forged insert can't attach another account's tag id.
DROP POLICY IF EXISTS conversation_tags_modify ON conversation_tags;
CREATE POLICY conversation_tags_modify ON conversation_tags FOR ALL USING (
  EXISTS (SELECT 1 FROM conversations c
          WHERE c.id = conversation_tags.conversation_id
            AND is_account_member(c.account_id, 'agent'))
) WITH CHECK (
  EXISTS (SELECT 1 FROM conversations c
          JOIN tags t ON t.id = conversation_tags.tag_id
                     AND t.account_id = c.account_id
          WHERE c.id = conversation_tags.conversation_id
            AND is_account_member(c.account_id, 'agent'))
);

-- ---- 3. Internal notes --------------------------------------------
-- A separate table, not a `messages` row with a flag: an internal note
-- can't leak into a customer-facing view through a missed filter,
-- because no message query ever reads this table.
CREATE TABLE IF NOT EXISTS conversation_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  author_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  body text NOT NULL CHECK (length(btrim(body)) > 0 AND length(body) <= 5000),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_conversation_notes_conversation
  ON conversation_notes (conversation_id, created_at);

ALTER TABLE conversation_notes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS conversation_notes_select ON conversation_notes;
CREATE POLICY conversation_notes_select ON conversation_notes FOR SELECT
  USING (is_account_member(account_id));

-- Insert: agent+, must author as yourself, and the conversation must
-- belong to the same account the row claims.
DROP POLICY IF EXISTS conversation_notes_insert ON conversation_notes;
CREATE POLICY conversation_notes_insert ON conversation_notes FOR INSERT
  WITH CHECK (
    is_account_member(account_id, 'agent')
    AND author_user_id = auth.uid()
    AND EXISTS (SELECT 1 FROM conversations c
                WHERE c.id = conversation_notes.conversation_id
                  AND c.account_id = conversation_notes.account_id)
  );

-- Delete: your own note, or admin+ for anyone's. No UPDATE policy —
-- notes are delete-and-rewrite, which keeps "who said what" honest.
DROP POLICY IF EXISTS conversation_notes_delete ON conversation_notes;
CREATE POLICY conversation_notes_delete ON conversation_notes FOR DELETE
  USING (
    (author_user_id = auth.uid() AND is_account_member(account_id, 'agent'))
    OR is_account_member(account_id, 'admin')
  );
