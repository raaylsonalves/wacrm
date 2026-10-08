-- ============================================================
-- 111: accent-insensitive inbox search.
--
-- Migration 110 indexed `ilike '%term%'`, which is case- but not
-- accent-insensitive: "orcamento" missed "orçamento", "joao" missed
-- "João". The search now compares unaccented, lower-cased text on both
-- sides, through two RPCs (PostgREST cannot filter on an expression),
-- each served by a trigram index on that same expression.
--
-- The RPCs are SECURITY INVOKER: RLS on messages / contacts still decides
-- which rows the caller sees, exactly like the plain selects they
-- replace.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;

-- unaccent() is only STABLE (it reads a dictionary), so it cannot back an
-- index. Naming the dictionary explicitly makes this wrapper safe to mark
-- IMMUTABLE — the standard pattern for indexing unaccent.
CREATE OR REPLACE FUNCTION public.search_fold(t text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $$
  SELECT lower(extensions.unaccent('extensions.unaccent'::regdictionary, coalesce(t, '')))
$$;

-- The plain-column indexes from 110 are superseded by these.
DROP INDEX IF EXISTS public.idx_messages_content_trgm;
DROP INDEX IF EXISTS public.idx_contacts_name_trgm;

CREATE INDEX IF NOT EXISTS idx_messages_content_fold_trgm
  ON public.messages USING gin (public.search_fold(content_text) extensions.gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_contacts_name_fold_trgm
  ON public.contacts USING gin (public.search_fold(name) extensions.gin_trgm_ops);

-- `%` and `_` in the term are literal text, not wildcards.
CREATE OR REPLACE FUNCTION public.search_like_pattern(p_term text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT '%' || replace(replace(replace(public.search_fold(p_term), '\', '\\'), '%', '\%'), '_', '\_') || '%'
$$;

CREATE OR REPLACE FUNCTION public.inbox_search_messages(p_term text, p_limit int DEFAULT 50)
RETURNS TABLE (id uuid, conversation_id uuid, content_text text, created_at timestamptz)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT m.id, m.conversation_id, m.content_text, m.created_at
  FROM public.messages m
  WHERE length(trim(coalesce(p_term, ''))) >= 2
    AND public.search_fold(m.content_text) LIKE public.search_like_pattern(trim(p_term))
  ORDER BY m.created_at DESC
  LIMIT least(greatest(coalesce(p_limit, 50), 1), 100)
$$;

CREATE OR REPLACE FUNCTION public.inbox_search_contacts(p_term text, p_limit int DEFAULT 100)
RETURNS TABLE (id uuid)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT c.id
  FROM public.contacts c
  WHERE length(trim(coalesce(p_term, ''))) >= 2
    AND (
      public.search_fold(c.name) LIKE public.search_like_pattern(trim(p_term))
      OR c.phone ILIKE public.search_like_pattern(trim(p_term))
    )
  LIMIT least(greatest(coalesce(p_limit, 100), 1), 200)
$$;

GRANT EXECUTE ON FUNCTION public.inbox_search_messages(text, int) TO authenticated;
GRANT EXECUTE ON FUNCTION public.inbox_search_contacts(text, int) TO authenticated;
