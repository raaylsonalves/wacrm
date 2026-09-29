-- ============================================================
-- 084_contact_avatars.sql — when a contact's profile picture was last
-- looked up (inbox visual refresh; ported from deskcomm's contact-avatars).
--
-- contacts.avatar_url already exists (migration 001) and the inbox renders
-- it; nothing filled it. A sweep now does, for contacts reachable over a
-- WAHA number (the official Cloud API exposes no customer profile photo).
-- NULL = never looked up: those go first.
--
-- Additive and idempotent.
-- ============================================================
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS avatar_updated_at timestamptz;
