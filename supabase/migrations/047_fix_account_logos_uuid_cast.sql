-- ============================================================
-- 047_fix_account_logos_uuid_cast.sql — stop casting an arbitrary
--                                        storage path segment to uuid
--
-- The problem
--
--   044's three account-logos write policies are:
--
--     bucket_id = 'account-logos'
--     AND is_account_member(((storage.foldername(name))[1])::uuid, 'admin')
--
--   RLS policies on storage.objects are evaluated for every bucket's
--   writes, not just this one. Postgres is not guaranteed to
--   short-circuit AND on `bucket_id = 'account-logos'` before
--   evaluating the cast — the planner can reorder quals within a
--   single boolean expression based on cost estimates. The
--   `flow-media` bucket's own convention is `account-<uuid>/...`
--   (020_account_sharing_followups.sql), which is not castable to
--   uuid at all, and would raise 22P02 (invalid_text_representation)
--   instead of just failing the check, if this policy's cast ever ran
--   first. That failure would surface as an opaque 500 on totally
--   unrelated uploads (avatars, flow media) with no obvious link back
--   to this migration.
--
--   020 already avoids exactly this trap on flow-media by comparing
--   as text instead of casting the path segment. 044 should have
--   followed the same pattern and didn't.
--
-- The fix
--
--   Replace the cast with a text comparison against profiles.account_id,
--   mirroring is_account_member('admin')'s own role check inline so the
--   folder segment is never coerced to a type it might not satisfy.
-- ============================================================

DROP POLICY IF EXISTS "Admins can upload their account logo" ON storage.objects;
CREATE POLICY "Admins can upload their account logo"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'account-logos'
    AND EXISTS (
      SELECT 1 FROM profiles p
      WHERE p.user_id = auth.uid()
        AND p.account_id::text = (storage.foldername(name))[1]
        AND p.account_role IN ('admin', 'owner')
    )
  );

DROP POLICY IF EXISTS "Admins can update their account logo" ON storage.objects;
CREATE POLICY "Admins can update their account logo"
  ON storage.objects FOR UPDATE
  USING (
    bucket_id = 'account-logos'
    AND EXISTS (
      SELECT 1 FROM profiles p
      WHERE p.user_id = auth.uid()
        AND p.account_id::text = (storage.foldername(name))[1]
        AND p.account_role IN ('admin', 'owner')
    )
  );

DROP POLICY IF EXISTS "Admins can delete their account logo" ON storage.objects;
CREATE POLICY "Admins can delete their account logo"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'account-logos'
    AND EXISTS (
      SELECT 1 FROM profiles p
      WHERE p.user_id = auth.uid()
        AND p.account_id::text = (storage.foldername(name))[1]
        AND p.account_role IN ('admin', 'owner')
    )
  );
