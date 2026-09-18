-- ============================================================
-- Conversations — denormalized last-message sender type
-- ============================================================
-- specs/inbox-response-time-sla.md: the inbox needs a live "this
-- customer has been waiting N minutes" indicator per conversation.
-- `last_message_text`/`last_message_at` are already denormalized onto
-- `conversations` at every send/receive site — this adds the one
-- missing piece (who sent it) using the same pattern, so the inbox
-- can tell "still waiting on us" (last message from the customer)
-- apart from "we already replied" (last message from an agent/bot)
-- without a join or a second query per conversation.

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS last_message_sender_type TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'conversations_last_message_sender_type_check'
      AND conrelid = 'public.conversations'::regclass
  ) THEN
    ALTER TABLE conversations
      ADD CONSTRAINT conversations_last_message_sender_type_check
      CHECK (last_message_sender_type IN ('customer', 'agent', 'bot'));
  END IF;
END $$;

-- Backfill existing rows from each conversation's actual most recent
-- message, so the indicator is correct immediately for conversations
-- that predate this column instead of waiting for their next message.
UPDATE conversations c
SET last_message_sender_type = m.sender_type
FROM (
  SELECT DISTINCT ON (conversation_id) conversation_id, sender_type
  FROM messages
  ORDER BY conversation_id, created_at DESC
) m
WHERE m.conversation_id = c.id
  AND c.last_message_sender_type IS NULL;

-- The inbound webhook path updates `conversations` through this
-- SECURITY DEFINER function (migration 037), not a direct client
-- UPDATE — every inbound message is from the customer by definition,
-- so the value is hardcoded rather than threaded through as a new
-- parameter.
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
      updated_at                = NOW()
  WHERE id = p_conversation_id;
$$;
