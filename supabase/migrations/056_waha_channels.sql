-- ============================================================
-- 056_waha_channels.sql — WAHA connection (specs/waha-channel-
-- connection.md), first slice.
--
-- Additive only: `whatsapp_config` (Cloud API, one row per account,
-- migration 017's UNIQUE(account_id)) is untouched. WAHA channels
-- live in their own table, many rows per account allowed — a
-- deliberately narrower cut than the full spec's `whatsapp_channels`
-- merge of both providers, chosen to keep this migration reversible
-- and to avoid touching any of the 17 call sites that assume
-- `whatsapp_config` is Cloud-API-only.
--
-- `conversations.whatsapp_channel_id` is how an outbound send
-- (`sendMessageToConversation`) and the inbox learn a conversation
-- started on a WAHA channel instead of the account's Cloud API
-- number. NULL (the default, and the only value that existed before
-- this migration) means "Cloud API", unchanged.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS whatsapp_waha_channels (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- Sender-of-record for contacts/conversations this channel's inbound
  -- webhook creates (both have a NOT NULL user_id FK) — same role
  -- `whatsapp_config.user_id` already plays for the Cloud API webhook.
  -- The admin who connected the channel; arbitrary once there's more
  -- than one admin, but stable.
  created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- How the user labels this number in the UI ("Vendas", "Suporte 2").
  label text NOT NULL,
  -- 'connecting' (session created, QR not yet scanned) ->
  -- 'connected' (WAHA reports WORKING) -> 'disconnected' (WAHA
  -- reports FAILED/STOPPED, or we haven't heard a status in a while).
  status text NOT NULL DEFAULT 'connecting'
    CHECK (status IN ('connecting', 'connected', 'disconnected')),
  waha_base_url text NOT NULL,
  -- AES-256-GCM-encrypted, same scheme as whatsapp_config.access_token
  -- (lib/whatsapp/encryption.ts). This key is the WHOLE WAHA
  -- instance's, not per-session — a leak exposes every session on
  -- that VPS, not just this one (called out explicitly in the spec
  -- and in the connect UI's copy).
  waha_api_key text NOT NULL,
  -- The session name inside WAHA (one WAHA session = one WhatsApp
  -- number). Generated at connect time, not user-chosen.
  waha_session_name text NOT NULL,
  -- HMAC secret WAHA signs its webhook calls with (config.webhooks[].hmac
  -- at session-create time). AES-256-GCM-encrypted, generated per
  -- channel, never reused across channels or accounts.
  webhook_secret text NOT NULL,
  connected_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_waha_channels_account
  ON whatsapp_waha_channels (account_id);

-- One WAHA session per (instance, session name) pair — guards against
-- the same physical session somehow being registered twice.
CREATE UNIQUE INDEX IF NOT EXISTS idx_waha_channels_session
  ON whatsapp_waha_channels (waha_base_url, waha_session_name);

ALTER TABLE whatsapp_waha_channels ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS waha_channels_select ON whatsapp_waha_channels;
CREATE POLICY waha_channels_select ON whatsapp_waha_channels FOR SELECT
  USING (is_account_member(account_id));

-- INSERT / UPDATE / DELETE: admin+ only — mirrors whatsapp_config's
-- settings-class gate (the connect route also enforces this with
-- requireRole('admin'); RLS is belt-and-braces for any other path).
DROP POLICY IF EXISTS waha_channels_insert ON whatsapp_waha_channels;
CREATE POLICY waha_channels_insert ON whatsapp_waha_channels FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS waha_channels_update ON whatsapp_waha_channels;
CREATE POLICY waha_channels_update ON whatsapp_waha_channels FOR UPDATE
  USING (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS waha_channels_delete ON whatsapp_waha_channels;
CREATE POLICY waha_channels_delete ON whatsapp_waha_channels FOR DELETE
  USING (is_account_member(account_id, 'admin'));

-- The webhook resolves a channel by session name under the
-- service-role client (no auth.uid()), same as whatsapp_config's own
-- webhook lookup — RLS above governs dashboard access only.

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS whatsapp_channel_id uuid
    REFERENCES whatsapp_waha_channels(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_conversations_whatsapp_channel
  ON conversations (whatsapp_channel_id) WHERE whatsapp_channel_id IS NOT NULL;
