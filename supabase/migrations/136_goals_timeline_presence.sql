-- ============================================================
-- 136: goals, per-person timeline and presence history
-- (specs/painel-gestor.md, phase 4).
--
--   * presence_sessions — member_presence only knows "now". Each
--     heartbeat (every 30s, lib/presence HEARTBEAT_MS) now also extends
--     the caller's current session of that status, or opens a new one
--     after a gap of 90s. Sum of online sessions = hours online.
--   * team_goals — daily / monthly targets per person (user_id) or for
--     the whole team (user_id NULL).
--   * member_timeline — one person's day: online stretches, replies per
--     hour, deals won / lost / moved, appointments, internal notes.
--   * team_performance fix: deals.assigned_to references profiles.id,
--     not the user id; 133 compared it with user ids, so a won deal
--     with an owner was credited to nobody.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.presence_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('online', 'away')),
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_presence_sessions_user
  ON public.presence_sessions (user_id, ended_at DESC);
CREATE INDEX IF NOT EXISTS idx_presence_sessions_account
  ON public.presence_sessions (account_id, started_at);

ALTER TABLE public.presence_sessions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS presence_sessions_select ON public.presence_sessions;
CREATE POLICY presence_sessions_select ON public.presence_sessions FOR SELECT
  USING (is_account_member(account_id, 'viewer'));
-- Written only by touch_presence (SECURITY DEFINER).
REVOKE INSERT, UPDATE, DELETE ON public.presence_sessions FROM authenticated, anon;

CREATE OR REPLACE FUNCTION public.touch_presence(
  p_status TEXT DEFAULT 'online'
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account_id UUID;
  v_session UUID;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  IF p_status NOT IN ('online', 'away') THEN
    RAISE EXCEPTION 'Invalid presence status: %', p_status
      USING ERRCODE = '22023';
  END IF;

  SELECT account_id INTO v_account_id
  FROM profiles
  WHERE user_id = auth.uid();

  IF v_account_id IS NULL THEN
    RAISE EXCEPTION 'No account for caller' USING ERRCODE = '22023';
  END IF;

  INSERT INTO member_presence (user_id, account_id, status, last_seen_at)
  VALUES (auth.uid(), v_account_id, p_status, now())
  ON CONFLICT (user_id) DO UPDATE
    SET status       = excluded.status,
        last_seen_at = now(),
        account_id   = excluded.account_id;

  -- Presence history: extend the running stretch, or start a new one.
  SELECT id INTO v_session
    FROM presence_sessions
   WHERE user_id = auth.uid()
     AND ended_at > now() - interval '90 seconds'
   ORDER BY ended_at DESC
   LIMIT 1;

  IF v_session IS NOT NULL AND EXISTS (
    SELECT 1 FROM presence_sessions WHERE id = v_session AND status = p_status
  ) THEN
    UPDATE presence_sessions SET ended_at = now() WHERE id = v_session;
  ELSE
    -- A status change closes the previous stretch where it was.
    INSERT INTO presence_sessions (account_id, user_id, status)
    VALUES (v_account_id, auth.uid(), p_status);
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS public.team_goals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  -- NULL = the whole team.
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  metric text NOT NULL CHECK (metric IN ('won_value', 'deals_won', 'appointments', 'conversations')),
  period text NOT NULL CHECK (period IN ('day', 'month')),
  target numeric NOT NULL CHECK (target > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_team_goals
  ON public.team_goals (account_id, coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid), metric, period);

ALTER TABLE public.team_goals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS team_goals_select ON public.team_goals;
CREATE POLICY team_goals_select ON public.team_goals FOR SELECT
  USING (is_account_member(account_id, 'viewer'));
DROP POLICY IF EXISTS team_goals_insert ON public.team_goals;
CREATE POLICY team_goals_insert ON public.team_goals FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS team_goals_update ON public.team_goals;
CREATE POLICY team_goals_update ON public.team_goals FOR UPDATE
  USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS team_goals_delete ON public.team_goals;
CREATE POLICY team_goals_delete ON public.team_goals FOR DELETE
  USING (is_account_member(account_id, 'admin'));

-- 133's function, with the deal owner resolved through profiles.id.
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
    SELECT coalesce(owner.user_id, e.actor_user_id) AS user_id,
           count(DISTINCT d.id) AS deals_won,
           coalesce(sum(d.value), 0) AS won_value
      FROM deal_events e
      JOIN deals d ON d.id = e.deal_id
      LEFT JOIN profiles owner ON owner.id = d.assigned_to
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

-- Online / away time per person in a window, clipped to it.
CREATE OR REPLACE FUNCTION public.team_presence_minutes(
  p_account_id uuid, p_from timestamptz, p_to timestamptz
)
RETURNS TABLE (user_id uuid, online_minutes numeric, away_minutes numeric, first_seen timestamptz, last_seen timestamptz)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public
AS $$
  SELECT s.user_id,
         round(sum(extract(epoch FROM least(s.ended_at, p_to) - greatest(s.started_at, p_from)))
               FILTER (WHERE s.status = 'online') / 60.0, 1),
         round(sum(extract(epoch FROM least(s.ended_at, p_to) - greatest(s.started_at, p_from)))
               FILTER (WHERE s.status = 'away') / 60.0, 1),
         min(greatest(s.started_at, p_from)),
         max(least(s.ended_at, p_to))
    FROM presence_sessions s
   WHERE s.account_id = p_account_id
     AND s.ended_at > p_from AND s.started_at < p_to
   GROUP BY s.user_id
$$;

-- One person's day, newest first. `kind` drives the icon and the text.
CREATE OR REPLACE FUNCTION public.member_timeline(
  p_account_id uuid, p_user_id uuid, p_from timestamptz, p_to timestamptz
)
RETURNS TABLE (at timestamptz, kind text, label text, amount numeric, ref_id uuid, ended_at timestamptz)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public
AS $$
  -- Online / away stretches.
  SELECT s.started_at, s.status, NULL::text, NULL::numeric, NULL::uuid, s.ended_at
    FROM presence_sessions s
   WHERE s.account_id = p_account_id AND s.user_id = p_user_id
     AND s.ended_at > p_from AND s.started_at < p_to
  UNION ALL
  -- Replies, one row per hour with the count.
  SELECT date_trunc('hour', m.created_at), 'replies', NULL, count(*)::numeric, NULL, NULL
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
   WHERE c.account_id = p_account_id AND m.sender_type = 'agent'
     AND m.sender_id = p_user_id
     AND m.created_at >= p_from AND m.created_at < p_to
   GROUP BY 1
  UNION ALL
  -- Deals this person won, lost or moved.
  SELECT e.created_at,
         CASE WHEN e.kind = 'status' THEN 'deal_' || (e.to_value #>> '{}')
              WHEN e.kind = 'created' THEN 'deal_created' ELSE 'deal_stage' END,
         d.title,
         CASE WHEN e.kind = 'status' THEN d.value END,
         d.id, NULL
    FROM deal_events e
    JOIN deals d ON d.id = e.deal_id
   WHERE e.account_id = p_account_id AND e.actor_user_id = p_user_id
     AND e.kind IN ('status', 'stage', 'created')
     AND e.created_at >= p_from AND e.created_at < p_to
  UNION ALL
  -- Appointments booked for them.
  SELECT a.created_at, 'appointment', a.title, NULL, a.id, a.starts_at
    FROM appointments a
   WHERE a.account_id = p_account_id AND a.assigned_to = p_user_id
     AND a.created_at >= p_from AND a.created_at < p_to
  UNION ALL
  -- Internal notes they wrote.
  SELECT n.created_at, 'note', left(n.body, 140), NULL, n.conversation_id, NULL
    FROM conversation_notes n
   WHERE n.account_id = p_account_id AND n.author_user_id = p_user_id
     AND n.created_at >= p_from AND n.created_at < p_to
  ORDER BY 1 DESC
  LIMIT 300
$$;
