-- ============================================================
-- 133: the manager's view of the team (specs/painel-gestor.md, phase 1).
--
-- Three read-only functions, SECURITY INVOKER like 089 and 127: they run
-- under the caller's RLS (account members only) and also filter by the
-- account passed in.
--
--   team_live(account, since)
--     One row per account member: presence, conversations assigned and
--     open, how many of those wait on the customer side (and since when),
--     replies sent since `since` (the start of the local day).
--
--   team_performance(account, from, to)
--     One row per member for a period: conversations they replied in,
--     replies, deals won (count and value, by who owns the deal, else who
--     marked it won), appointments assigned to them.
--     Response times come from service_responses (127), aggregated in TS.
--
--   attention_items(account, target_minutes)
--     Open conversations that need a person now: waiting longer than the
--     target, waiting with nobody assigned, or handed off by the AI and
--     still unanswered. At most 50, oldest wait first.
-- ============================================================

CREATE OR REPLACE FUNCTION public.team_live(p_account_id uuid, p_since timestamptz)
RETURNS TABLE (
  user_id uuid,
  full_name text,
  account_role text,
  presence text,
  last_seen_at timestamptz,
  open_count bigint,
  waiting_count bigint,
  oldest_wait_at timestamptz,
  replies_since bigint
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT p.user_id,
         p.full_name,
         p.account_role::text,
         CASE
           WHEN mp.last_seen_at IS NULL THEN 'offline'
           WHEN mp.last_seen_at < now() - interval '2 minutes' THEN 'offline'
           ELSE mp.status
         END,
         mp.last_seen_at,
         (SELECT count(*) FROM conversations c
           WHERE c.account_id = p_account_id AND c.assigned_agent_id = p.user_id
             AND c.status <> 'closed'),
         (SELECT count(*) FROM conversations c
           WHERE c.account_id = p_account_id AND c.assigned_agent_id = p.user_id
             AND c.status <> 'closed' AND c.last_message_sender_type = 'customer'),
         (SELECT min(c.last_customer_message_at) FROM conversations c
           WHERE c.account_id = p_account_id AND c.assigned_agent_id = p.user_id
             AND c.status <> 'closed' AND c.last_message_sender_type = 'customer'),
         (SELECT count(*) FROM messages m
            JOIN conversations c ON c.id = m.conversation_id
           WHERE c.account_id = p_account_id AND m.sender_type = 'agent'
             AND m.sender_id = p.user_id AND m.created_at >= p_since)
    FROM profiles p
    LEFT JOIN member_presence mp ON mp.user_id = p.user_id
   WHERE p.account_id = p_account_id
$$;

CREATE OR REPLACE FUNCTION public.team_performance(
  p_account_id uuid,
  p_from timestamptz,
  p_to timestamptz
) RETURNS TABLE (
  user_id uuid,
  conversations bigint,
  replies bigint,
  deals_won bigint,
  won_value numeric,
  appointments bigint
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH replies AS (
    SELECT m.sender_id AS user_id,
           count(DISTINCT m.conversation_id) AS conversations,
           count(*) AS replies
      FROM messages m
      JOIN conversations c ON c.id = m.conversation_id
     WHERE c.account_id = p_account_id AND m.sender_type = 'agent'
       AND m.sender_id IS NOT NULL
       AND m.created_at >= p_from AND m.created_at < p_to
     GROUP BY m.sender_id
  ), won AS (
    SELECT coalesce(d.assigned_to, e.actor_user_id) AS user_id,
           count(DISTINCT d.id) AS deals_won,
           coalesce(sum(d.value), 0) AS won_value
      FROM deal_events e
      JOIN deals d ON d.id = e.deal_id
     WHERE e.account_id = p_account_id AND e.kind = 'status'
       AND e.to_value = '"won"'::jsonb
       AND e.created_at >= p_from AND e.created_at < p_to
     GROUP BY 1
  ), appts AS (
    SELECT a.assigned_to AS user_id, count(*) AS appointments
      FROM appointments a
     WHERE a.account_id = p_account_id AND a.assigned_to IS NOT NULL
       AND a.created_at >= p_from AND a.created_at < p_to
       AND a.status <> 'cancelled'
     GROUP BY a.assigned_to
  )
  SELECT p.user_id,
         coalesce(r.conversations, 0),
         coalesce(r.replies, 0),
         coalesce(w.deals_won, 0),
         coalesce(w.won_value, 0),
         coalesce(a.appointments, 0)
    FROM profiles p
    LEFT JOIN replies r ON r.user_id = p.user_id
    LEFT JOIN won w ON w.user_id = p.user_id
    LEFT JOIN appts a ON a.user_id = p.user_id
   WHERE p.account_id = p_account_id
$$;

CREATE OR REPLACE FUNCTION public.attention_items(p_account_id uuid, p_target_minutes int)
RETURNS TABLE (
  conversation_id uuid,
  contact_name text,
  contact_phone text,
  assigned_agent_id uuid,
  waiting_since timestamptz,
  reason text,
  handoff_reason text
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT c.id,
         ct.name,
         ct.phone,
         c.assigned_agent_id,
         c.last_customer_message_at,
         CASE
           WHEN c.ai_autoreply_disabled AND c.ai_handoff_reason IS NOT NULL
                AND c.ai_handoff_reason <> 'automated_sender' THEN 'ai_handoff'
           WHEN c.assigned_agent_id IS NULL THEN 'unassigned'
           ELSE 'late'
         END,
         c.ai_handoff_reason
    FROM conversations c
    LEFT JOIN contacts ct ON ct.id = c.contact_id
   WHERE c.account_id = p_account_id
     AND c.status <> 'closed'
     AND c.last_message_sender_type = 'customer'
     AND c.last_customer_message_at IS NOT NULL
     AND coalesce(c.ai_handoff_reason, '') <> 'automated_sender'
     AND (c.snoozed_until IS NULL OR c.snoozed_until < now())
     AND (
           -- a person owes the reply: the AI is off for this thread (or
           -- handed it off), someone owns it, or it has waited past the
           -- seconds an active AI takes to answer
           c.ai_autoreply_disabled OR c.assigned_agent_id IS NOT NULL
           OR c.last_customer_message_at < now() - interval '3 minutes'
         )
     AND (
           c.last_customer_message_at < now() - make_interval(mins => greatest(p_target_minutes, 1))
           OR c.assigned_agent_id IS NULL
           OR c.ai_handoff_reason IS NOT NULL
         )
   ORDER BY c.last_customer_message_at ASC
   LIMIT 50
$$;

REVOKE ALL ON FUNCTION public.team_live(uuid, timestamptz) FROM public, anon;
REVOKE ALL ON FUNCTION public.team_performance(uuid, timestamptz, timestamptz) FROM public, anon;
REVOKE ALL ON FUNCTION public.attention_items(uuid, int) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.team_live(uuid, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.team_performance(uuid, timestamptz, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.attention_items(uuid, int) TO authenticated;
