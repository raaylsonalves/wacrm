-- ============================================================
-- 130: external scheduling providers for the AI agent
-- (specs/parceiro-scale-duvidas.md — ScaLE partner API v1).
--
-- An account can point its AI agenda tools at a partner's booking system
-- instead of wacrm's own calendar. The partner owns the agenda (units,
-- services, professionals, free times); the AI only reads it and books.
--
--   * scheduling_integrations — one per account. The partner key is
--     AES-256-GCM encrypted (lib/whatsapp/encryption) and, like
--     calendar_connections.refresh_token_enc, never selectable by a
--     browser: column privileges leave it out.
--   * external_bookings — what the AI booked there, so the conversation
--     and the contact keep a history ("qual é o meu horário?") even though
--     the appointment itself lives in the partner's system. Times are the
--     partner's local wall time, exactly as it returns them (no zone).
-- ============================================================

CREATE TABLE IF NOT EXISTS public.scheduling_integrations (
  account_id uuid PRIMARY KEY REFERENCES public.accounts(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('scale')),
  api_key_enc text NOT NULL,
  base_url text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  -- Shown on the settings card: who the key belongs to (from /unidades).
  label text,
  last_error text,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.scheduling_integrations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS scheduling_integrations_select ON public.scheduling_integrations;
CREATE POLICY scheduling_integrations_select ON public.scheduling_integrations FOR SELECT
  USING (is_account_member(account_id, 'viewer'));
-- Writes go through /api/integrations/scale (service role) only.
REVOKE ALL ON public.scheduling_integrations FROM authenticated, anon;
GRANT SELECT (account_id, provider, base_url, enabled, label, last_error, created_at, updated_at)
  ON public.scheduling_integrations TO authenticated;

CREATE TABLE IF NOT EXISTS public.external_bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('scale')),
  external_id text NOT NULL,
  code text,
  conversation_id uuid REFERENCES public.conversations(id) ON DELETE SET NULL,
  contact_id uuid REFERENCES public.contacts(id) ON DELETE SET NULL,
  unit_id text,
  professional_id text,
  professional_name text,
  services jsonb NOT NULL DEFAULT '[]',
  starts_local timestamp NOT NULL,
  ends_local timestamp,
  status text NOT NULL DEFAULT 'agendado',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, provider, external_id)
);

CREATE INDEX IF NOT EXISTS idx_external_bookings_contact
  ON public.external_bookings (account_id, contact_id, starts_local);

ALTER TABLE public.external_bookings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS external_bookings_select ON public.external_bookings;
CREATE POLICY external_bookings_select ON public.external_bookings FOR SELECT
  USING (is_account_member(account_id, 'viewer'));
REVOKE INSERT, UPDATE, DELETE ON public.external_bookings FROM authenticated, anon;
