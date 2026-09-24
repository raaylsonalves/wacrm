-- ============================================================
-- 063_ai_knowledge_fts_or_match.sql — OR lexical terms instead of
--                                      ANDing every word
--
-- The problem
--
--   `match_ai_knowledge_fts` (030, re-created as SECURITY INVOKER in
--   032) builds its tsquery with `plainto_tsquery`, which ANDs every
--   word in the caller's text. A real customer question ("quanto
--   custa o corte de cabelo?") carries filler words ("quanto", "custa",
--   "o", "de") that don't appear verbatim in a knowledge chunk, so the
--   AND fails and the account's own KB content never gets retrieved —
--   observed live on an account with no embeddings key configured
--   (accounts without one are lexical-only, see knowledge.ts).
--
-- The fix
--
--   Build the tsquery by ORing the query's own lexemes together
--   instead of ANDing them, so a chunk matches on ANY shared word and
--   `ts_rank` naturally scores chunks that share more words higher.
--   Deliberately still uses the `'simple'` config — same as the
--   generated `fts` column — to stay language-neutral for other
--   forks (see 030's comment); this is strictly an AND→OR change, not
--   a stemming/stopword change. A fork serving one language can get
--   real stemming by changing `'simple'` to that language's config in
--   both this function and the `fts` column definition.
-- ============================================================

CREATE OR REPLACE FUNCTION public.match_ai_knowledge_fts(
  p_account_id  uuid,
  p_query       text,
  p_match_count integer
)
RETURNS TABLE (id uuid, content text, rank real) AS $$
  SELECT c.id,
         c.content,
         ts_rank(c.fts, q.tsq) AS rank
  FROM ai_knowledge_chunks c,
       LATERAL (
         SELECT to_tsquery('simple', string_agg(lexeme, ' | ')) AS tsq
         FROM unnest(tsvector_to_array(to_tsvector('simple', p_query))) AS lexeme
       ) q
  WHERE c.account_id = p_account_id
    AND q.tsq IS NOT NULL
    AND c.fts @@ q.tsq
  ORDER BY rank DESC
  LIMIT GREATEST(p_match_count, 0);
$$ LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public;

-- Re-assert the EXECUTE grant (CREATE OR REPLACE preserves it, but
-- keep it explicit and re-runnable — mirrors 030/032).
REVOKE ALL ON FUNCTION public.match_ai_knowledge_fts(uuid, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.match_ai_knowledge_fts(uuid, text, integer) TO authenticated, service_role;
