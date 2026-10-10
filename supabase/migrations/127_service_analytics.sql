-- ============================================================
-- 127: service analytics (the "Atendimento" report page).
--
-- Two read-only functions, SECURITY INVOKER: they run under the caller's
-- RLS (conversations / messages are visible to account members only) and
-- also filter by the account passed in, which must be the caller's.
--
--   service_leads(account, from, to)
--     One row per conversation whose FIRST customer message falls in the
--     period: when the lead arrived, when and by whom it was first
--     answered (AI, automation or a person). Paginated by PostgREST
--     (.range) like a table.
--
--   service_responses(account, from, to)
--     Every "customer waited → someone answered" in the period: from the
--     first message of a customer block to the first reply after it, with
--     who replied. The page aggregates these per person / per day.
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_messages_conversation_created
  ON public.messages (conversation_id, created_at);

CREATE OR REPLACE FUNCTION public.service_leads(
  p_account_id uuid,
  p_from timestamptz,
  p_to timestamptz
) RETURNS TABLE (
  conversation_id uuid,
  contact_id uuid,
  contact_name text,
  contact_phone text,
  whatsapp_config_id uuid,
  whatsapp_channel_id uuid,
  arrived_at timestamptz,
  first_reply_at timestamptz,
  first_reply_kind text,
  first_reply_user_id uuid,
  assigned_agent_id uuid,
  status text
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH firsts AS (
    SELECT m.conversation_id, min(m.created_at) AS arrived_at
      FROM messages m
      JOIN conversations c ON c.id = m.conversation_id
     WHERE c.account_id = p_account_id
       AND m.sender_type = 'customer'
     GROUP BY m.conversation_id
    HAVING min(m.created_at) >= p_from AND min(m.created_at) < p_to
  )
  SELECT c.id,
         c.contact_id,
         ct.name,
         ct.phone,
         c.whatsapp_config_id,
         c.whatsapp_channel_id,
         f.arrived_at,
         r.created_at,
         CASE
           WHEN r.id IS NULL THEN NULL
           WHEN r.sender_type = 'agent' THEN 'human'
           WHEN r.ai_generated THEN 'ai'
           ELSE 'automation'
         END,
         CASE WHEN r.sender_type = 'agent' THEN r.sender_id END,
         c.assigned_agent_id,
         c.status
    FROM firsts f
    JOIN conversations c ON c.id = f.conversation_id
    LEFT JOIN contacts ct ON ct.id = c.contact_id
    LEFT JOIN LATERAL (
      SELECT m2.id, m2.created_at, m2.sender_type, m2.sender_id, m2.ai_generated
        FROM messages m2
       WHERE m2.conversation_id = c.id
         AND m2.sender_type IN ('agent', 'bot')
         AND m2.created_at >= f.arrived_at
       ORDER BY m2.created_at
       LIMIT 1
    ) r ON true
   ORDER BY f.arrived_at DESC;
$$;

CREATE OR REPLACE FUNCTION public.service_responses(
  p_account_id uuid,
  p_from timestamptz,
  p_to timestamptz
) RETURNS TABLE (
  conversation_id uuid,
  customer_at timestamptz,
  replied_at timestamptz,
  reply_kind text,
  reply_user_id uuid
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH m AS (
    SELECT msg.id, msg.conversation_id, msg.created_at, msg.sender_type,
           msg.sender_id, msg.ai_generated,
           -- a new group starts at every non-customer message, so the
           -- customer messages before a reply share the reply's group - 1
           sum(CASE WHEN msg.sender_type = 'customer' THEN 0 ELSE 1 END)
             OVER (PARTITION BY msg.conversation_id ORDER BY msg.created_at, msg.id) AS grp
      FROM messages msg
      JOIN conversations c ON c.id = msg.conversation_id
     WHERE c.account_id = p_account_id
       -- a little before the period, so a reply early in it still finds
       -- the customer message it answers
       AND msg.created_at >= p_from - interval '3 days'
       AND msg.created_at < p_to
  ),
  blocks AS (
    SELECT conversation_id, grp, min(created_at) AS start_at
      FROM m
     WHERE sender_type = 'customer'
     GROUP BY conversation_id, grp
  )
  SELECT r.conversation_id,
         b.start_at,
         r.created_at,
         CASE
           WHEN r.sender_type = 'agent' THEN 'human'
           WHEN r.ai_generated THEN 'ai'
           ELSE 'automation'
         END,
         CASE WHEN r.sender_type = 'agent' THEN r.sender_id END
    FROM m r
    JOIN blocks b
      ON b.conversation_id = r.conversation_id AND b.grp = r.grp - 1
   WHERE r.sender_type IN ('agent', 'bot')
     AND r.created_at >= p_from
     AND r.created_at < p_to;
$$;

REVOKE ALL ON FUNCTION public.service_leads(uuid, timestamptz, timestamptz) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.service_responses(uuid, timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.service_leads(uuid, timestamptz, timestamptz) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.service_responses(uuid, timestamptz, timestamptz) TO authenticated, service_role;
