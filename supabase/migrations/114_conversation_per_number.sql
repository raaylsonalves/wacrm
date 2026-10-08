-- ============================================================
-- 114: one conversation per (contact, number) — stage 2b of
-- specs/multi-official-numbers.md.
--
-- 1. Conversations. "One conversation per contact" (migration 036)
--    becomes "one per contact AND number": the same customer writing to
--    reception and to sales gets two threads, each with its own history,
--    assignee, status and AI. The number key is the WAHA channel when
--    set, else the official number (whatsapp_config_id). Existing rows
--    keep their ids; they already carry a number (112 backfill).
--
-- 2. ai_channel_agents gains whatsapp_config_id so each OFFICIAL number
--    can have its own agent, like WAHA channels (migration 074). The
--    legacy "Cloud API" slot (both ids NULL) moves to the primary number.
--
-- 3. messages.ai_agent_id: which AI agent wrote a bot message, so an
--    agent reading the history can tell its own turns from a human's or
--    another agent's (the router can hand a conversation over).
-- ============================================================

-- 1. ---------------------------------------------------------
DROP INDEX IF EXISTS public.idx_conversations_account_contact;

CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_account_contact_number
  ON public.conversations (
    account_id,
    contact_id,
    coalesce(
      whatsapp_channel_id,
      whatsapp_config_id,
      '00000000-0000-0000-0000-000000000000'::uuid
    )
  );

CREATE INDEX IF NOT EXISTS idx_conversations_account_contact
  ON public.conversations (account_id, contact_id);

-- 2. ---------------------------------------------------------
ALTER TABLE public.ai_channel_agents
  ADD COLUMN IF NOT EXISTS whatsapp_config_id uuid
    REFERENCES public.whatsapp_config(id) ON DELETE CASCADE;

UPDATE public.ai_channel_agents a
SET whatsapp_config_id = w.id
FROM public.whatsapp_config w
WHERE w.account_id = a.account_id
  AND w.is_primary
  AND a.channel_id IS NULL
  AND a.whatsapp_config_id IS NULL;

DROP INDEX IF EXISTS public.idx_ai_channel_agents_channel;
CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_channel_agents_number
  ON public.ai_channel_agents (
    account_id,
    coalesce(
      channel_id,
      whatsapp_config_id,
      '00000000-0000-0000-0000-000000000000'::uuid
    )
  );

CREATE OR REPLACE FUNCTION public.check_ai_channel_agent_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM ai_configs a
    WHERE a.id = NEW.agent_id AND a.account_id = NEW.account_id
  ) THEN
    RAISE EXCEPTION 'agent does not belong to this account'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.channel_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM whatsapp_waha_channels c
    WHERE c.id = NEW.channel_id AND c.account_id = NEW.account_id
  ) THEN
    RAISE EXCEPTION 'channel does not belong to this account'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.whatsapp_config_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM whatsapp_config w
    WHERE w.id = NEW.whatsapp_config_id AND w.account_id = NEW.account_id
  ) THEN
    RAISE EXCEPTION 'number does not belong to this account'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

-- 3. ---------------------------------------------------------
ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS ai_agent_id uuid
    REFERENCES public.ai_configs(id) ON DELETE SET NULL;
