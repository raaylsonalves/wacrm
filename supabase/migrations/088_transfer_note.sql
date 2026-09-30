-- ============================================================
-- Transfer with a note (inbox "hand to a teammate")
-- ============================================================
-- The transfer dialog saves the note as a conversation_notes row and then
-- assigns. The assignment alert now carries that note (a note by the same
-- person on this conversation in the last minute), so the teammate knows
-- why before opening the thread. Rewrites 086's function; nothing else
-- changes.

CREATE OR REPLACE FUNCTION notify_conversation_assigned()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_contact_name text;
  v_actor_name text;
  v_kind text;
  v_note text;
BEGIN
  IF NEW.assigned_agent_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.assigned_agent_id IS NOT DISTINCT FROM OLD.assigned_agent_id THEN
    RETURN NEW;
  END IF;
  -- Self-assignment ("assign to me") needs no alert.
  IF auth.uid() IS NOT NULL AND auth.uid() = NEW.assigned_agent_id THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(NULLIF(name, ''), phone) INTO v_contact_name
    FROM contacts WHERE id = NEW.contact_id;

  IF auth.uid() IS NOT NULL THEN
    v_kind := 'human';
    SELECT full_name INTO v_actor_name FROM profiles WHERE user_id = auth.uid();
    -- The note the transfer dialog saved just before assigning.
    SELECT body INTO v_note FROM conversation_notes
     WHERE conversation_id = NEW.id AND author_user_id = auth.uid()
       AND created_at > now() - interval '1 minute'
     ORDER BY created_at DESC LIMIT 1;
  ELSIF NEW.ai_autoreply_disabled AND NEW.ai_handoff_reason IS NOT NULL THEN
    v_kind := 'ai';
  ELSE
    v_kind := 'rule';
  END IF;

  PERFORM upsert_notification(
    NEW.account_id, NEW.assigned_agent_id, 'conversation_assigned',
    NEW.id, NEW.contact_id, auth.uid(), v_actor_name, v_contact_name,
    NULL, NULL,
    jsonb_build_object(
      'actor_kind', v_kind,
      'handoff_reason', NEW.ai_handoff_reason,
      'summary', left(NEW.ai_handoff_summary, 300),
      'last_message', left(NEW.last_message_text, 200),
      'note', left(v_note, 500)
    ),
    '/inbox?c=' || NEW.id,
    NULL
  );
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'assignment notification failed for conversation %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;
ALTER FUNCTION notify_conversation_assigned() OWNER TO postgres;
