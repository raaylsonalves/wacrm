-- ============================================================
-- 110: trigram indexes for the inbox search.
--
-- The inbox search box (components/inbox/conversation-list.tsx) runs
-- `ilike '%term%'` over every message of the account, and over contact
-- names and phones. A leading wildcard cannot use a btree index, so
-- without these the search is a sequential scan of `messages`, which
-- grows without bound. pg_trgm GIN indexes serve `ilike '%term%'`.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;

CREATE INDEX IF NOT EXISTS idx_messages_content_trgm
  ON public.messages USING gin (content_text extensions.gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_contacts_name_trgm
  ON public.contacts USING gin (name extensions.gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_contacts_phone_trgm
  ON public.contacts USING gin (phone extensions.gin_trgm_ops);
