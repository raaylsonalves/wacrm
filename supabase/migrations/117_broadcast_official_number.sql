-- ============================================================
-- 117: which official number a broadcast goes out through
-- (specs/multi-official-numbers.md, stage 3).
--
-- An account with several official numbers (a custom plan, migration
-- 116) picks one in the broadcast wizard. NULL = the primary number,
-- exactly the single-number behaviour. A scheduled or resumed broadcast
-- reads it back so it leaves through the same number it was created for.
-- WAHA broadcasts keep using primary_channel_id (migration 068).
-- ============================================================

ALTER TABLE public.broadcasts
  ADD COLUMN IF NOT EXISTS whatsapp_config_id uuid
    REFERENCES public.whatsapp_config(id) ON DELETE SET NULL;
