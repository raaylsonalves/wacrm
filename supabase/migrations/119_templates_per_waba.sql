-- ============================================================
-- 119: message templates belong to a WhatsApp Business Account (WABA)
-- (specs/multi-official-numbers.md).
--
-- An account's official numbers can live in different WABAs, and a
-- template exists — and can be sent — only in the WABA it was created
-- in. Templates now record their WABA, the sync reads every WABA the
-- account's numbers belong to, and the broadcast wizard only offers the
-- numbers that can send the chosen template.
--
-- Uniqueness moves from (user_id, name, language) — a pre-017 leftover
-- that let teammates shadow each other — to (account_id, waba_id, name,
-- language): Meta's own `hello_world` exists in every WABA. waba_id is
-- NOT NULL DEFAULT '' (unknown) so the key stays a plain column list
-- PostgREST can upsert on.
-- ============================================================

ALTER TABLE public.message_templates
  ADD COLUMN IF NOT EXISTS waba_id text NOT NULL DEFAULT '';

UPDATE public.message_templates t
SET waba_id = w.waba_id
FROM public.whatsapp_config w
WHERE w.account_id = t.account_id
  AND w.is_primary
  AND w.waba_id IS NOT NULL
  AND t.waba_id = '';

DROP INDEX IF EXISTS public.message_templates_user_name_language_key;
CREATE UNIQUE INDEX IF NOT EXISTS message_templates_account_waba_name_language_key
  ON public.message_templates (account_id, waba_id, name, language);
