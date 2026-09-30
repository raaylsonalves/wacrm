-- ============================================================
-- Dashboard operations blocks (team today, AI vs team, heatmap)
-- ============================================================
-- Aggregates the browser can't do cheaply: messages carry no account_id,
-- and pulling a month of rows to count them client-side doesn't scale.
-- SECURITY INVOKER on purpose — the caller's RLS (messages via their
-- conversation's account) still decides what is counted; p_account only
-- narrows further.

CREATE OR REPLACE FUNCTION dashboard_team_since(p_account uuid, p_since timestamptz)
RETURNS TABLE (user_id uuid, replies bigint, conversations bigint)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT m.sender_id, count(*), count(DISTINCT m.conversation_id)
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
   WHERE c.account_id = p_account
     AND m.sender_type = 'agent'
     AND m.sender_id IS NOT NULL
     AND m.created_at >= p_since
   GROUP BY m.sender_id;
$$;

CREATE OR REPLACE FUNCTION dashboard_ai_vs_team(p_account uuid, p_since timestamptz)
RETURNS TABLE (ai_replies bigint, team_replies bigint, customer_messages bigint,
               ai_conversations bigint, team_conversations bigint)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT
    count(*) FILTER (WHERE m.sender_type = 'bot' AND m.ai_generated),
    count(*) FILTER (WHERE m.sender_type = 'agent'),
    count(*) FILTER (WHERE m.sender_type = 'customer'),
    count(DISTINCT m.conversation_id) FILTER (WHERE m.sender_type = 'bot' AND m.ai_generated),
    count(DISTINCT m.conversation_id) FILTER (WHERE m.sender_type = 'agent')
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
   WHERE c.account_id = p_account
     AND m.created_at >= p_since;
$$;

-- Customer messages by weekday (0 = Sunday) and hour, in p_tz.
CREATE OR REPLACE FUNCTION dashboard_inbound_heatmap(p_account uuid, p_since timestamptz, p_tz text)
RETURNS TABLE (dow int, hour int, n bigint)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT extract(dow FROM m.created_at AT TIME ZONE p_tz)::int,
         extract(hour FROM m.created_at AT TIME ZONE p_tz)::int,
         count(*)
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
   WHERE c.account_id = p_account
     AND m.sender_type = 'customer'
     AND m.created_at >= p_since
   GROUP BY 1, 2;
$$;

GRANT EXECUTE ON FUNCTION dashboard_team_since(uuid, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION dashboard_ai_vs_team(uuid, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION dashboard_inbound_heatmap(uuid, timestamptz, text) TO authenticated;
