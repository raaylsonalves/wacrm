-- ============================================================
-- 113: managing several official numbers — stage 2 of
-- specs/multi-official-numbers.md.
--
-- * display_phone_number: the "+55 85 9…" Meta reports for the number,
--   stored on save so the numbers list shows it without a Meta call per
--   row.
-- * set_primary_whatsapp_number(): moving the primary flag is two
--   updates (clear the old, set the new) under a partial unique index
--   (migration 112); done in one function so a failure between them can
--   never leave the account without a primary — every "the account's
--   number" read depends on there being one.
-- ============================================================

ALTER TABLE public.whatsapp_config
  ADD COLUMN IF NOT EXISTS display_phone_number text;

-- SECURITY INVOKER: the caller's RLS applies (whatsapp_config writes are
-- admin-only, migration 017). A number from another account matches no
-- row and the function raises.
CREATE OR REPLACE FUNCTION public.set_primary_whatsapp_number(p_config_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_account uuid;
BEGIN
  SELECT account_id INTO v_account
  FROM public.whatsapp_config
  WHERE id = p_config_id;
  IF v_account IS NULL THEN
    RAISE EXCEPTION 'number not found' USING ERRCODE = 'P0002';
  END IF;

  UPDATE public.whatsapp_config
  SET is_primary = false
  WHERE account_id = v_account AND is_primary AND id <> p_config_id;

  UPDATE public.whatsapp_config
  SET is_primary = true
  WHERE id = p_config_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'number not updatable' USING ERRCODE = '42501';
  END IF;
END
$$;

GRANT EXECUTE ON FUNCTION public.set_primary_whatsapp_number(uuid) TO authenticated;
