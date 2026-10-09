-- ============================================================
-- 126: claim_ai_reply_turn — "newer" only counts messages that will get
-- their own AI dispatch (QA of review 2026-10, A3).
--
-- 123 dropped a reply whenever ANY newer customer row existed, trusting
-- that row's dispatch to answer the burst. But the webhook only hands a
-- message to the AI when it carries text (or is a voice note): a photo
-- without caption, a sticker or a document sent while the reply was being
-- written left the customer with no answer at all. Now only a newer
-- message with text or audio supersedes the reply.
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
       AND (nullif(btrim(content_text), '') IS NOT NULL OR content_type = 'audio')
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
