-- ============================================================
-- Notifications — carry raw names instead of pre-rendered English
-- ============================================================
-- notify_conversation_assigned() (migration 027) wrote a fully-formed
-- English sentence into title/body ("New conversation assigned" /
-- "<actor> assigned you a conversation with <contact>"), which shipped
-- English text into pt-BR/es/ko deployments regardless of
-- NEXT_PUBLIC_APP_LOCALE — the same class of bug already fixed for
-- automation/flow templates. The trigger only has the actor/contact
-- *names*, not sentence structure, so it should hand those over raw and
-- let the client (which has the locale) build the sentence via
-- next-intl. title/body stay for rows written before this migration.

ALTER TABLE notifications ALTER COLUMN title DROP NOT NULL;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS actor_name TEXT;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS contact_name TEXT;

CREATE OR REPLACE FUNCTION notify_conversation_assigned()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_contact_name TEXT;
  v_actor_name TEXT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.assigned_agent_id IS NULL THEN
      RETURN NEW;
    END IF;
  ELSE
    IF NEW.assigned_agent_id IS NULL
       OR NEW.assigned_agent_id IS NOT DISTINCT FROM OLD.assigned_agent_id THEN
      RETURN NEW;
    END IF;
  END IF;

  -- Skip self-assignment — nothing to notify the agent about.
  IF auth.uid() IS NOT NULL AND auth.uid() = NEW.assigned_agent_id THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(NULLIF(name, ''), phone) INTO v_contact_name
  FROM contacts WHERE id = NEW.contact_id;

  IF auth.uid() IS NOT NULL THEN
    SELECT full_name INTO v_actor_name
    FROM profiles WHERE user_id = auth.uid();
  END IF;

  INSERT INTO notifications (
    account_id, user_id, type, conversation_id, contact_id,
    actor_user_id, actor_name, contact_name
  ) VALUES (
    NEW.account_id,
    NEW.assigned_agent_id,
    'conversation_assigned',
    NEW.id,
    NEW.contact_id,
    auth.uid(),
    v_actor_name,
    v_contact_name
  );

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Never let a notification failure block the assignment itself.
  RAISE WARNING 'Failed to create assignment notification for conversation %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

ALTER FUNCTION notify_conversation_assigned() OWNER TO postgres;
