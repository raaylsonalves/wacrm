-- ============================================================
-- Notifications v2 — every event a person should hear about
-- ============================================================
-- Until now there were four types (assignment + three case alerts), no
-- grouping and no preferences. This migration:
--   * adds the catalogue `notification_types` (the single source of the
--     type list and its defaults — the UI and the push dispatcher read it);
--   * adds per-user `notification_preferences` (in-app / push per type);
--   * lets a notification carry structured `data`, a `link`, a `group_key`
--     (+ `count`) so "Ana sent 3 messages" is one row, and `pushed_at` so
--     the cron dispatcher knows what still needs a push;
--   * rewrites the assignment trigger to say WHO handed the conversation
--     over (a teammate, the AI hand-off, or automatic distribution) and
--     why, instead of "Someone assigned you a conversation";
--   * adds DB triggers for the events that are plain row changes: new
--     unassigned conversation, deal won / lost / stage change, WAHA
--     channel disconnected, template approved / rejected, broadcast done.
-- Server-side events (customer replied, AI stopped, SLA, reminders, AI
-- key failure) are written by lib/notifications/notify.ts.

-- ---- catalogue ------------------------------------------------------
CREATE TABLE IF NOT EXISTS notification_types (
  type            text PRIMARY KEY,
  category        text NOT NULL CHECK (category IN ('conversations', 'sales', 'system')),
  in_app_default  boolean NOT NULL DEFAULT true,
  push_default    boolean NOT NULL DEFAULT true,
  position        int NOT NULL DEFAULT 0
);

INSERT INTO notification_types (type, category, in_app_default, push_default, position) VALUES
  ('conversation_assigned', 'conversations', true,  true,  10),
  ('customer_replied',      'conversations', true,  true,  20),
  ('handoff_waiting',       'conversations', true,  true,  30),
  ('sla_breached',          'conversations', true,  true,  40),
  ('new_unassigned',        'conversations', false, false, 50),
  ('case_opened',           'conversations', true,  true,  60),
  ('case_lead_replied',     'conversations', true,  true,  70),
  ('case_relay_failed',     'conversations', true,  true,  80),
  ('appointment_reminder',  'sales',         true,  true,  110),
  ('deal_won',              'sales',         true,  true,  120),
  ('deal_lost',             'sales',         true,  false, 130),
  ('deal_stage_changed',    'sales',         true,  false, 140),
  ('channel_disconnected',  'system',        true,  true,  210),
  ('ai_provider_failed',    'system',        true,  true,  220),
  ('template_status',       'system',        true,  false, 230),
  ('broadcast_finished',    'system',        true,  false, 240)
ON CONFLICT (type) DO UPDATE SET
  category = EXCLUDED.category,
  in_app_default = EXCLUDED.in_app_default,
  push_default = EXCLUDED.push_default,
  position = EXCLUDED.position;

ALTER TABLE notification_types ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS notification_types_read ON notification_types;
CREATE POLICY notification_types_read ON notification_types FOR SELECT
  USING (auth.role() = 'authenticated');

-- ---- preferences ----------------------------------------------------
CREATE TABLE IF NOT EXISTS notification_preferences (
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  type       text NOT NULL REFERENCES notification_types(type) ON DELETE CASCADE,
  in_app     boolean NOT NULL,
  push       boolean NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, type)
);
ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS notification_preferences_own ON notification_preferences;
CREATE POLICY notification_preferences_own ON notification_preferences FOR ALL
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- ---- notification columns ------------------------------------------
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS data jsonb;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS link text;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS group_key text;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS count int NOT NULL DEFAULT 1;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS pushed_at timestamptz;

ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications
  ADD CONSTRAINT notifications_type_check
  CHECK (type IN (
    'conversation_assigned', 'customer_replied', 'handoff_waiting',
    'sla_breached', 'new_unassigned', 'case_opened', 'case_lead_replied',
    'case_relay_failed', 'appointment_reminder', 'deal_won', 'deal_lost',
    'deal_stage_changed', 'channel_disconnected', 'ai_provider_failed',
    'template_status', 'broadcast_finished'
  ));

-- One unread row per group: the next event bumps it instead of adding a row.
CREATE UNIQUE INDEX IF NOT EXISTS uq_notifications_unread_group
  ON notifications (user_id, group_key)
  WHERE read_at IS NULL AND group_key IS NOT NULL;
-- The push dispatcher's scan.
CREATE INDEX IF NOT EXISTS idx_notifications_push_pending
  ON notifications (created_at)
  WHERE pushed_at IS NULL;

-- Markers so cron-driven alerts fire once per episode.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS sla_notified_at timestamptz;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS team_reminded_at timestamptz;

-- ---- helpers --------------------------------------------------------
-- Is this type on in-app for this user? (row, else the catalogue default)
CREATE OR REPLACE FUNCTION notification_in_app_enabled(p_user uuid, p_type text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT in_app FROM notification_preferences WHERE user_id = p_user AND type = p_type),
    (SELECT in_app_default FROM notification_types WHERE type = p_type),
    true
  );
$$;

-- Insert, or bump the unread row of the same group. The single write path
-- for every notification (triggers and server code alike), so preferences
-- and grouping hold everywhere.
CREATE OR REPLACE FUNCTION upsert_notification(
  p_account uuid, p_user uuid, p_type text,
  p_conversation uuid, p_contact uuid, p_actor uuid,
  p_actor_name text, p_contact_name text,
  p_title text, p_body text, p_data jsonb, p_link text, p_group_key text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF p_user IS NULL OR NOT notification_in_app_enabled(p_user, p_type) THEN
    RETURN NULL;
  END IF;

  IF p_group_key IS NOT NULL THEN
    UPDATE notifications
       SET count = count + 1,
           body = COALESCE(p_body, body),
           data = COALESCE(p_data, data),
           title = COALESCE(p_title, title),
           created_at = now(),
           pushed_at = NULL
     WHERE user_id = p_user AND group_key = p_group_key AND read_at IS NULL
     RETURNING id INTO v_id;
    IF v_id IS NOT NULL THEN
      RETURN v_id;
    END IF;
  END IF;

  INSERT INTO notifications (
    account_id, user_id, type, conversation_id, contact_id, actor_user_id,
    actor_name, contact_name, title, body, data, link, group_key
  ) VALUES (
    p_account, p_user, p_type, p_conversation, p_contact, p_actor,
    p_actor_name, p_contact_name, p_title, p_body, p_data, p_link, p_group_key
  )
  ON CONFLICT (user_id, group_key) WHERE read_at IS NULL AND group_key IS NOT NULL
  DO UPDATE SET count = notifications.count + 1, created_at = now(), pushed_at = NULL
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION upsert_notification(uuid, uuid, text, uuid, uuid, uuid, text, text, text, text, jsonb, text, text) FROM PUBLIC, anon, authenticated;

-- Who hears about a conversation nobody owns: the channel's routing
-- responsibles, else every agent and above.
CREATE OR REPLACE FUNCTION notification_team_for(p_account uuid, p_channel uuid)
RETURNS SETOF uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_policy uuid;
BEGIN
  SELECT id INTO v_policy FROM channel_routing_policies
   WHERE account_id = p_account
     AND waha_channel_id IS NOT DISTINCT FROM p_channel
   LIMIT 1;
  IF v_policy IS NOT NULL AND EXISTS (
    SELECT 1 FROM channel_routing_responsibles WHERE policy_id = v_policy
  ) THEN
    RETURN QUERY SELECT user_id FROM channel_routing_responsibles WHERE policy_id = v_policy;
    RETURN;
  END IF;
  RETURN QUERY SELECT user_id FROM profiles
   WHERE account_id = p_account AND account_role IN ('owner', 'admin', 'agent');
END;
$$;

CREATE OR REPLACE FUNCTION notification_admins_for(p_account uuid)
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT user_id FROM profiles WHERE account_id = p_account AND account_role IN ('owner', 'admin');
$$;

-- ---- assignment (rewrite of 027/048) ---------------------------------
-- Says who handed it over: a teammate (auth.uid()), the AI hand-off (the
-- row is in hand-off state), or automatic distribution; and carries the
-- hand-off summary / last message so the alert is actionable.
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
      'last_message', left(NEW.last_message_text, 200)
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

-- ---- new conversation nobody owns ------------------------------------
CREATE OR REPLACE FUNCTION notify_new_unassigned()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_contact_name text;
  v_user uuid;
BEGIN
  IF NEW.assigned_agent_id IS NOT NULL THEN
    RETURN NEW;
  END IF;
  SELECT COALESCE(NULLIF(name, ''), phone) INTO v_contact_name
    FROM contacts WHERE id = NEW.contact_id;
  FOR v_user IN SELECT * FROM notification_team_for(NEW.account_id, NEW.whatsapp_channel_id) LOOP
    PERFORM upsert_notification(
      NEW.account_id, v_user, 'new_unassigned', NEW.id, NEW.contact_id, NULL,
      NULL, v_contact_name, NULL, NULL, NULL,
      '/inbox?c=' || NEW.id, 'new:' || NEW.id
    );
  END LOOP;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'new-conversation notification failed for %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;
ALTER FUNCTION notify_new_unassigned() OWNER TO postgres;
DROP TRIGGER IF EXISTS on_conversation_created_unassigned ON conversations;
CREATE TRIGGER on_conversation_created_unassigned
  AFTER INSERT ON conversations
  FOR EACH ROW EXECUTE FUNCTION notify_new_unassigned();

-- ---- deals ----------------------------------------------------------
-- The deal's owner (assigned_to, else its creator) hears about won / lost
-- / stage moves — unless they made the change themselves.
CREATE OR REPLACE FUNCTION notify_deal_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner uuid := COALESCE(NEW.assigned_to, NEW.user_id);
  v_actor_name text;
  v_contact_name text;
  v_type text;
  v_from text;
  v_to text;
BEGIN
  IF v_owner IS NULL OR (auth.uid() IS NOT NULL AND auth.uid() = v_owner) THEN
    RETURN NEW;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status IN ('won', 'lost') THEN
    v_type := 'deal_' || NEW.status;
  ELSIF NEW.stage_id IS DISTINCT FROM OLD.stage_id AND NEW.status = 'open' THEN
    v_type := 'deal_stage_changed';
    SELECT name INTO v_from FROM pipeline_stages WHERE id = OLD.stage_id;
    SELECT name INTO v_to FROM pipeline_stages WHERE id = NEW.stage_id;
  ELSE
    RETURN NEW;
  END IF;

  IF auth.uid() IS NOT NULL THEN
    SELECT full_name INTO v_actor_name FROM profiles WHERE user_id = auth.uid();
  END IF;
  IF NEW.contact_id IS NOT NULL THEN
    SELECT COALESCE(NULLIF(name, ''), phone) INTO v_contact_name FROM contacts WHERE id = NEW.contact_id;
  END IF;

  PERFORM upsert_notification(
    NEW.account_id, v_owner, v_type, NEW.conversation_id, NEW.contact_id,
    auth.uid(), v_actor_name, v_contact_name, NULL, NULL,
    jsonb_build_object(
      'deal_title', NEW.title, 'value', NEW.value, 'currency', NEW.currency,
      'from_stage', v_from, 'to_stage', v_to
    ),
    '/pipelines',
    CASE WHEN v_type = 'deal_stage_changed' THEN 'deal_stage:' || NEW.id ELSE NULL END
  );
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'deal notification failed for %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;
ALTER FUNCTION notify_deal_change() OWNER TO postgres;
DROP TRIGGER IF EXISTS on_deal_changed_notify ON deals;
CREATE TRIGGER on_deal_changed_notify
  AFTER UPDATE OF status, stage_id ON deals
  FOR EACH ROW EXECUTE FUNCTION notify_deal_change();

-- ---- WAHA channel disconnected ---------------------------------------
CREATE OR REPLACE FUNCTION notify_channel_disconnected()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid;
BEGIN
  IF NEW.status = 'disconnected' AND OLD.status IS DISTINCT FROM 'disconnected' THEN
    FOR v_user IN SELECT * FROM notification_admins_for(NEW.account_id) LOOP
      PERFORM upsert_notification(
        NEW.account_id, v_user, 'channel_disconnected', NULL, NULL, NULL,
        NULL, NULL, NULL, NULL, jsonb_build_object('channel', NEW.label),
        '/settings?tab=whatsapp', 'channel:' || NEW.id
      );
    END LOOP;
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'channel notification failed for %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;
ALTER FUNCTION notify_channel_disconnected() OWNER TO postgres;
DROP TRIGGER IF EXISTS on_waha_channel_disconnected ON whatsapp_waha_channels;
CREATE TRIGGER on_waha_channel_disconnected
  AFTER UPDATE OF status ON whatsapp_waha_channels
  FOR EACH ROW EXECUTE FUNCTION notify_channel_disconnected();

-- ---- template approved / rejected ------------------------------------
CREATE OR REPLACE FUNCTION notify_template_status()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid;
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status
     AND upper(NEW.status) IN ('APPROVED', 'REJECTED', 'PAUSED', 'DISABLED') THEN
    FOR v_user IN SELECT * FROM notification_admins_for(NEW.account_id) LOOP
      PERFORM upsert_notification(
        NEW.account_id, v_user, 'template_status', NULL, NULL, NULL,
        NULL, NULL, NULL, NULL,
        jsonb_build_object('template', NEW.name, 'status', upper(NEW.status),
                           'reason', NEW.rejection_reason),
        '/settings?tab=templates', NULL
      );
    END LOOP;
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'template notification failed for %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;
ALTER FUNCTION notify_template_status() OWNER TO postgres;
DROP TRIGGER IF EXISTS on_template_status_notify ON message_templates;
CREATE TRIGGER on_template_status_notify
  AFTER UPDATE OF status ON message_templates
  FOR EACH ROW EXECUTE FUNCTION notify_template_status();

-- ---- broadcast finished ---------------------------------------------
CREATE OR REPLACE FUNCTION notify_broadcast_finished()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status IN ('sent', 'failed') AND OLD.status IS DISTINCT FROM NEW.status THEN
    PERFORM upsert_notification(
      NEW.account_id, NEW.user_id, 'broadcast_finished', NULL, NULL, NULL,
      NULL, NULL, NULL, NULL,
      jsonb_build_object('broadcast', NEW.name, 'status', NEW.status,
                         'sent', NEW.sent_count, 'failed', NEW.failed_count,
                         'total', NEW.total_recipients),
      '/broadcasts', NULL
    );
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'broadcast notification failed for %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;
ALTER FUNCTION notify_broadcast_finished() OWNER TO postgres;
DROP TRIGGER IF EXISTS on_broadcast_finished_notify ON broadcasts;
CREATE TRIGGER on_broadcast_finished_notify
  AFTER UPDATE OF status ON broadcasts
  FOR EACH ROW EXECUTE FUNCTION notify_broadcast_finished();
