-- ============================================================
-- 118: responsible agents per OFFICIAL number
-- (specs/multi-official-numbers.md, stage 3; extends migration 069).
--
-- channel_routing_policies was keyed by WAHA channel, with NULL meaning
-- "the" Cloud API number. With several official numbers (migration 112)
-- each can have its own responsibles: policies gain whatsapp_config_id,
-- the legacy Cloud API policy moves to the account's primary number, and
-- every lookup goes through routing_policy_for(), which resolves a
-- conversation's number the same way the app does (WAHA channel, else its
-- official number, else the primary) and falls back to a legacy row.
-- ============================================================

ALTER TABLE public.channel_routing_policies
  ADD COLUMN IF NOT EXISTS whatsapp_config_id uuid
    REFERENCES public.whatsapp_config(id) ON DELETE CASCADE;

UPDATE public.channel_routing_policies p
SET whatsapp_config_id = w.id
FROM public.whatsapp_config w
WHERE w.account_id = p.account_id
  AND w.is_primary
  AND p.waha_channel_id IS NULL
  AND p.whatsapp_config_id IS NULL;

DROP INDEX IF EXISTS public.idx_channel_routing_policies_cloud_api;
CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_routing_policies_cloud_api
  ON public.channel_routing_policies (account_id)
  WHERE waha_channel_id IS NULL AND whatsapp_config_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_routing_policies_official
  ON public.channel_routing_policies (whatsapp_config_id)
  WHERE whatsapp_config_id IS NOT NULL;

-- The policy governing a conversation's number. Specific beats legacy.
CREATE OR REPLACE FUNCTION public.routing_policy_for(
  p_account uuid,
  p_channel uuid,
  p_config uuid
)
RETURNS uuid
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT p.id
  FROM channel_routing_policies p
  WHERE p.account_id = p_account
    AND (
      (p_channel IS NOT NULL AND p.waha_channel_id = p_channel)
      OR (
        p_channel IS NULL
        AND p.waha_channel_id IS NULL
        AND (
          p.whatsapp_config_id = coalesce(
            p_config,
            (SELECT w.id FROM whatsapp_config w
              WHERE w.account_id = p_account AND w.is_primary)
          )
          OR p.whatsapp_config_id IS NULL
        )
      )
    )
  ORDER BY (p.whatsapp_config_id IS NULL)
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION public.enforce_channel_routing_assignment()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_policy_id uuid;
  v_eligible boolean;
BEGIN
  IF NEW.assigned_agent_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.assigned_agent_id IS NOT DISTINCT FROM OLD.assigned_agent_id THEN
    RETURN NEW;
  END IF;

  v_policy_id := routing_policy_for(
    NEW.account_id, NEW.whatsapp_channel_id, NEW.whatsapp_config_id
  );
  IF v_policy_id IS NULL THEN
    RETURN NEW; -- unrestricted
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM channel_routing_responsibles
    WHERE policy_id = v_policy_id AND user_id = NEW.assigned_agent_id
  ) INTO v_eligible;

  IF NOT v_eligible THEN
    RAISE EXCEPTION 'assigned_agent_id is not eligible for this channel''s routing policy'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- Who hears about a conversation nobody owns, now per official number.
CREATE OR REPLACE FUNCTION public.notification_team_for_number(
  p_account uuid,
  p_channel uuid,
  p_config uuid
)
RETURNS SETOF uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_policy uuid;
BEGIN
  v_policy := routing_policy_for(p_account, p_channel, p_config);
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
REVOKE ALL ON FUNCTION public.notification_team_for_number(uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated;

-- The 2-argument form keeps working (primary number for the official side).
CREATE OR REPLACE FUNCTION public.notification_team_for(p_account uuid, p_channel uuid)
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT * FROM notification_team_for_number(p_account, p_channel, NULL)
$$;

CREATE OR REPLACE FUNCTION public.notify_new_unassigned()
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
  FOR v_user IN SELECT * FROM notification_team_for_number(
    NEW.account_id, NEW.whatsapp_channel_id, NEW.whatsapp_config_id
  ) LOOP
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
