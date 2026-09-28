-- ============================================================
-- 068_broadcast_channel_rotation.sql — broadcast via WAHA, with
-- channel rotation (specs/broadcast-channel-rotation.md).
--
-- `broadcasts.primary_channel_id` NULL = Cloud API (today's only
-- mode, unchanged) — same NULL-means-Cloud-API convention
-- `conversations.whatsapp_channel_id` established in migration 056.
-- A non-NULL value means this broadcast sends via WAHA, anchored to
-- that channel; `broadcast_channel_pool` lists additional WAHA
-- channels it may rotate across (zero rows = no rotation, send only
-- from the primary).
--
-- `broadcast_recipients.sent_via_channel_id` records which channel
-- actually sent each recipient — NULL still means Cloud API, even for
-- rows created before this migration (nothing to backfill: every
-- existing row was necessarily sent via Cloud API, since WAHA
-- broadcasting didn't exist before this).
--
-- create_broadcast_with_recipients (037/038/041) gains
-- `p_primary_channel_id` as a trailing DEFAULT NULL parameter —
-- Postgres allows this via CREATE OR REPLACE without breaking the
-- existing 8-argument call `broadcast-core.ts` already makes.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE broadcasts
  ADD COLUMN IF NOT EXISTS primary_channel_id uuid
    REFERENCES whatsapp_waha_channels(id) ON DELETE SET NULL;

ALTER TABLE broadcast_recipients
  ADD COLUMN IF NOT EXISTS sent_via_channel_id uuid
    REFERENCES whatsapp_waha_channels(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS broadcast_channel_pool (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  broadcast_id uuid NOT NULL REFERENCES broadcasts(id) ON DELETE CASCADE,
  waha_channel_id uuid NOT NULL REFERENCES whatsapp_waha_channels(id) ON DELETE CASCADE,
  UNIQUE (broadcast_id, waha_channel_id)
);

ALTER TABLE broadcast_channel_pool ENABLE ROW LEVEL SECURITY;

-- No account_id of its own — scope through the parent broadcast, same
-- pattern ai_router_members uses for ai_routers (migration 066).
DROP POLICY IF EXISTS broadcast_channel_pool_select ON broadcast_channel_pool;
CREATE POLICY broadcast_channel_pool_select ON broadcast_channel_pool FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM broadcasts
    WHERE broadcasts.id = broadcast_channel_pool.broadcast_id
      AND is_account_member(broadcasts.account_id)
  ));
DROP POLICY IF EXISTS broadcast_channel_pool_write ON broadcast_channel_pool;
CREATE POLICY broadcast_channel_pool_write ON broadcast_channel_pool FOR ALL
  USING (EXISTS (
    SELECT 1 FROM broadcasts
    WHERE broadcasts.id = broadcast_channel_pool.broadcast_id
      AND is_account_member(broadcasts.account_id, 'agent')
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM broadcasts
    WHERE broadcasts.id = broadcast_channel_pool.broadcast_id
      AND is_account_member(broadcasts.account_id, 'agent')
  ));

-- Drop the 8-arg overload rather than letting CREATE OR REPLACE add a
-- 9-arg sibling next to it — a different argument COUNT is a
-- different overload to Postgres, not a replace, and broadcast-
-- core.ts is updated in this same change to always pass the 9th
-- argument. Leaving both would mean two functions doing almost the
-- same thing, one silently dead.
DROP FUNCTION IF EXISTS public.create_broadcast_with_recipients(
  UUID, UUID, TEXT, TEXT, TEXT, INTEGER, UUID[], JSONB[]
);

CREATE OR REPLACE FUNCTION public.create_broadcast_with_recipients(
  p_account_id        UUID,
  p_user_id           UUID,
  p_name              TEXT,
  p_template_name     TEXT,
  p_template_language TEXT,
  p_total_recipients  INTEGER,
  p_contact_ids       UUID[],
  p_template_params   JSONB[],
  p_primary_channel_id UUID DEFAULT NULL
)
RETURNS TABLE(broadcast_id UUID, recipient_id UUID, contact_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_broadcast_id UUID;
BEGIN
  INSERT INTO broadcasts (
    account_id, user_id, name, template_name,
    template_language, status, total_recipients, primary_channel_id
  )
  VALUES (
    p_account_id, p_user_id, p_name, p_template_name,
    p_template_language, 'sending', p_total_recipients, p_primary_channel_id
  )
  RETURNING id INTO v_broadcast_id;

  RETURN QUERY
  WITH ins AS (
    INSERT INTO broadcast_recipients (
      broadcast_id, contact_id, status, template_params
    )
    SELECT v_broadcast_id, t.cid, 'pending', t.prm
    FROM unnest(p_contact_ids, p_template_params) AS t(cid, prm)
    RETURNING id, broadcast_recipients.contact_id
  )
  SELECT v_broadcast_id, ins.id, ins.contact_id
  FROM ins;
END;
$$;

REVOKE ALL ON FUNCTION public.create_broadcast_with_recipients(UUID, UUID, TEXT, TEXT, TEXT, INTEGER, UUID[], JSONB[], UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_broadcast_with_recipients(UUID, UUID, TEXT, TEXT, TEXT, INTEGER, UUID[], JSONB[], UUID) FROM anon;
REVOKE ALL ON FUNCTION public.create_broadcast_with_recipients(UUID, UUID, TEXT, TEXT, TEXT, INTEGER, UUID[], JSONB[], UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.create_broadcast_with_recipients(UUID, UUID, TEXT, TEXT, TEXT, INTEGER, UUID[], JSONB[], UUID) TO service_role;
