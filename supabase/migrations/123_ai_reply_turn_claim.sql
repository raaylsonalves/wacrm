-- ============================================================
-- 123: claim an AI reply turn atomically, with the conditions that can
-- change while the reply is being generated (specs/review-2026-10.md A2, A3).
--
-- claim_ai_reply_slot (029) only checked the per-conversation cap. The
-- reply is generated for up to ~35 s (plus tool calls) after the last
-- "is a human here?" check, so:
--   * a person who took the conversation over meanwhile (assigned it, or
--     paused the AI) still got the bot's answer on top of theirs;
--   * a customer message that arrived meanwhile got its own reply too —
--     two answers for one burst, the first without the newest message.
-- claim_ai_reply_turn re-checks both under a row lock, in the same
-- statement that takes the slot, and says why it refused:
--   'claimed' | 'human' | 'newer' | 'cap' | 'missing'.
-- `p_answered_up_to` is the created_at of the newest customer message the
-- reply was built from (null = do not check for newer ones).
-- claim_ai_reply_slot is kept for code still deployed from before.
-- ============================================================

CREATE OR REPLACE FUNCTION public.claim_ai_reply_turn(
  p_conversation_id uuid,
  p_max_replies integer,
  p_answered_up_to timestamptz
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  c record;
BEGIN
  SELECT assigned_agent_id, ai_autoreply_disabled, ai_reply_count
    INTO c
    FROM conversations
   WHERE id = p_conversation_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'missing';
  END IF;
  IF c.assigned_agent_id IS NOT NULL OR coalesce(c.ai_autoreply_disabled, false) THEN
    RETURN 'human';
  END IF;
  IF p_answered_up_to IS NOT NULL AND EXISTS (
    SELECT 1 FROM messages
     WHERE conversation_id = p_conversation_id
       AND sender_type = 'customer'
       AND created_at > p_answered_up_to
  ) THEN
    RETURN 'newer';
  END IF;
  IF c.ai_reply_count >= p_max_replies THEN
    RETURN 'cap';
  END IF;
  UPDATE conversations
     SET ai_reply_count = ai_reply_count + 1
   WHERE id = p_conversation_id;
  RETURN 'claimed';
END;
$$;

REVOKE ALL ON FUNCTION public.claim_ai_reply_turn(uuid, integer, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_ai_reply_turn(uuid, integer, timestamptz)
  TO service_role;
