-- ============================================================
-- 044_account_branding.sql
--
-- Lets an account replace the default "wacrm" name/icon in the
-- sidebar with its own display name, logo, and brand color (see
-- specs/account-branding.md). All three are nullable — an account
-- that never opens Settings > Branding renders exactly as before.
--
-- `display_name` sits alongside the existing `name` column rather
-- than replacing it, same reasoning as `default_currency` (021):
-- `name` keeps whatever meaning existing code already gives it
-- (internal/billing label), `display_name` is purely presentational
-- and optional.
--
-- `brand_color` is validated at the DB layer (not just client-side)
-- so a malformed value can never reach the RLS-writable `accounts`
-- row and break the sidebar's inline style.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS display_name TEXT,
  ADD COLUMN IF NOT EXISTS logo_url TEXT,
  ADD COLUMN IF NOT EXISTS brand_color TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'accounts_brand_color_format'
  ) THEN
    ALTER TABLE accounts
      ADD CONSTRAINT accounts_brand_color_format
      CHECK (brand_color IS NULL OR brand_color ~ '^#[0-9a-fA-F]{6}$');
  END IF;
END $$;

COMMENT ON COLUMN accounts.display_name IS
  'Optional company/team name shown in the sidebar instead of the default app name. NULL = use the default.';
COMMENT ON COLUMN accounts.logo_url IS
  'Public Storage URL (account-logos bucket) shown in the sidebar instead of the default icon. NULL = use the default.';
COMMENT ON COLUMN accounts.brand_color IS
  'Optional #rrggbb override for --primary. NULL = use the member''s personal theme choice. Foreground contrast is computed client-side from this value, not stored.';

-- ============================================================
-- STORAGE — account-logos bucket
--
-- Same shape as the `avatars` bucket (008_profile_avatars_storage.sql):
-- public read (rendering <img> needs no signed URL), scoped writes.
-- Path convention: account-logos/{account_id}/logo-<timestamp>.<ext>
-- — the policies below key off the first path segment, so uploads are
-- gated on the uploader being an admin+ member of that account id,
-- not merely being *some* authenticated user.
-- ============================================================
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'account-logos',
  'account-logos',
  TRUE,
  2097152, -- 2 MB
  ARRAY['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml']
)
ON CONFLICT (id) DO UPDATE
SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "Account logos are publicly readable" ON storage.objects;
CREATE POLICY "Account logos are publicly readable"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'account-logos');

DROP POLICY IF EXISTS "Admins can upload their account logo" ON storage.objects;
CREATE POLICY "Admins can upload their account logo"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'account-logos'
    AND is_account_member(((storage.foldername(name))[1])::uuid, 'admin')
  );

DROP POLICY IF EXISTS "Admins can update their account logo" ON storage.objects;
CREATE POLICY "Admins can update their account logo"
  ON storage.objects FOR UPDATE
  USING (
    bucket_id = 'account-logos'
    AND is_account_member(((storage.foldername(name))[1])::uuid, 'admin')
  );

DROP POLICY IF EXISTS "Admins can delete their account logo" ON storage.objects;
CREATE POLICY "Admins can delete their account logo"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'account-logos'
    AND is_account_member(((storage.foldername(name))[1])::uuid, 'admin')
  );
