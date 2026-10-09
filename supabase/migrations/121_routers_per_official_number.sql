-- ============================================================
-- 121: AI routers per official (Meta) number.
--
-- A router was scoped to a WAHA channel or to the whole account, so with
-- several official numbers (migration 112) the only option for them was
-- "whole account". `whatsapp_config_id` scopes a router to one official
-- number; at most one of the two scopes is set.
--
-- The old unique index on (account_id, channel_id) let several ACTIVE
-- whole-account routers coexist (NULLs are distinct in a unique index).
-- The new one keys on the coalesced scope, so there is exactly one
-- active router per scope, whole account included.
-- ============================================================

ALTER TABLE public.ai_routers
  ADD COLUMN IF NOT EXISTS whatsapp_config_id uuid
    REFERENCES public.whatsapp_config(id) ON DELETE CASCADE;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ai_routers_one_scope'
  ) THEN
    ALTER TABLE public.ai_routers
      ADD CONSTRAINT ai_routers_one_scope
      CHECK (channel_id IS NULL OR whatsapp_config_id IS NULL);
  END IF;
END $$;

DROP INDEX IF EXISTS public.idx_ai_routers_active_per_channel;
CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_routers_active_per_scope
  ON public.ai_routers (
    account_id,
    coalesce(channel_id, whatsapp_config_id, '00000000-0000-0000-0000-000000000000'::uuid)
  )
  WHERE is_active;
