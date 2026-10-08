-- ============================================================
-- 112: more than one official (Meta Cloud API) number per account —
-- stage 1 of specs/multi-official-numbers.md.
--
-- "One number per account" (UNIQUE(account_id), migration 017) becomes
-- "one PRIMARY number per account": every existing read of "the
-- account's number" now filters is_primary, so an account with one
-- number behaves exactly as before. A conversation records which
-- official number it talks through (whatsapp_config_id); NULL means the
-- primary. whatsapp_channel_id keeps its meaning (NULL = official API,
-- set = a WAHA channel).
-- ============================================================

ALTER TABLE public.whatsapp_config
  ADD COLUMN IF NOT EXISTS is_primary boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS label text;

ALTER TABLE public.whatsapp_config
  DROP CONSTRAINT IF EXISTS whatsapp_config_account_id_key;
DROP INDEX IF EXISTS public.whatsapp_config_account_id_key;

CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_config_one_primary_per_account
  ON public.whatsapp_config (account_id) WHERE is_primary;

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS whatsapp_config_id uuid
    REFERENCES public.whatsapp_config(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_conversations_whatsapp_config
  ON public.conversations (whatsapp_config_id)
  WHERE whatsapp_config_id IS NOT NULL;

-- Existing official-API conversations talk through the account's only
-- (now primary) number.
UPDATE public.conversations c
SET whatsapp_config_id = w.id
FROM public.whatsapp_config w
WHERE w.account_id = c.account_id
  AND w.is_primary
  AND c.whatsapp_channel_id IS NULL
  AND c.whatsapp_config_id IS NULL;
