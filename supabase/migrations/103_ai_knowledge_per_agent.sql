-- 103_ai_knowledge_per_agent.sql
--
-- The knowledge base belonged to the account, so every agent (a
-- barbershop demo next to a clinic agent, say) answered from the same
-- documents. Each document — and its chunks, which retrieval reads —
-- now belongs to one agent, and an agent without documents has none:
-- there is no account-wide fallback.
--
-- Existing documents move to the account's default agent (else its
-- oldest), which is the agent that was already answering from them.
-- Deleting an agent deletes its documents.

ALTER TABLE ai_knowledge_documents
  ADD COLUMN IF NOT EXISTS agent_id uuid REFERENCES ai_configs(id) ON DELETE CASCADE;
ALTER TABLE ai_knowledge_chunks
  ADD COLUMN IF NOT EXISTS agent_id uuid REFERENCES ai_configs(id) ON DELETE CASCADE;

UPDATE ai_knowledge_documents d
SET agent_id = (
  SELECT c.id FROM ai_configs c
  WHERE c.account_id = d.account_id
  ORDER BY c.is_default DESC, c.created_at ASC
  LIMIT 1
)
WHERE d.agent_id IS NULL;

UPDATE ai_knowledge_chunks c
SET agent_id = d.agent_id
FROM ai_knowledge_documents d
WHERE c.document_id = d.id AND c.agent_id IS NULL;

CREATE INDEX IF NOT EXISTS ai_knowledge_documents_agent_id_idx
  ON ai_knowledge_documents (agent_id);
CREATE INDEX IF NOT EXISTS ai_knowledge_chunks_agent_id_idx
  ON ai_knowledge_chunks (agent_id);

-- Retrieval gains the agent. The 3-argument versions are dropped rather
-- than overloaded: PostgREST can't pick between overloads on named args.
DROP FUNCTION IF EXISTS public.match_ai_knowledge_fts(uuid, text, integer);
DROP FUNCTION IF EXISTS public.match_ai_knowledge_semantic(uuid, text, integer);

CREATE OR REPLACE FUNCTION public.match_ai_knowledge_fts(
  p_account_id  uuid,
  p_agent_id    uuid,
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
    AND c.agent_id = p_agent_id
    AND q.tsq IS NOT NULL
    AND c.fts @@ q.tsq
  ORDER BY rank DESC
  LIMIT GREATEST(p_match_count, 0);
$$ LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public;

CREATE OR REPLACE FUNCTION public.match_ai_knowledge_semantic(
  p_account_id      uuid,
  p_agent_id        uuid,
  p_query_embedding text,
  p_match_count     integer
)
RETURNS TABLE (id uuid, content text, distance real) AS $$
  SELECT c.id,
         c.content,
         (c.embedding <=> p_query_embedding::vector(1536)) AS distance
  FROM ai_knowledge_chunks c
  WHERE c.account_id = p_account_id
    AND c.agent_id = p_agent_id
    AND c.embedding IS NOT NULL
  ORDER BY c.embedding <=> p_query_embedding::vector(1536)
  LIMIT GREATEST(p_match_count, 0);
$$ LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public;

REVOKE ALL ON FUNCTION public.match_ai_knowledge_fts(uuid, uuid, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.match_ai_knowledge_fts(uuid, uuid, text, integer) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.match_ai_knowledge_semantic(uuid, uuid, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.match_ai_knowledge_semantic(uuid, uuid, text, integer) TO authenticated, service_role;
