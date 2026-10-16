-- ============================================================
-- 137: presence history that survives several open tabs.
--
-- 136 opened a new presence_sessions row on every status change. With
-- the CRM open in two tabs (one visible "online", one hidden "away")
-- the heartbeats alternate and the history shattered into 20-second
-- rows. Now one row = one connected stretch (beats less than 90s apart),
-- and it counts online seconds: the time since the previous beat is
-- online when any tab said "online" in the last 45s (last_online_at).
-- ============================================================

ALTER TABLE public.presence_sessions
  ADD COLUMN IF NOT EXISTS online_seconds integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_online_at timestamptz;

-- The shattered rows from 136's first hour carry nothing worth keeping.
DELETE FROM public.presence_sessions WHERE online_seconds = 0 AND last_online_at IS NULL;

CREATE OR REPLACE FUNCTION public.touch_presence(
  p_status TEXT DEFAULT 'online'
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account_id UUID;
  v_session presence_sessions%ROWTYPE;
  v_last_online timestamptz;
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

  SELECT * INTO v_session
    FROM presence_sessions
   WHERE user_id = auth.uid()
     AND ended_at > now() - interval '90 seconds'
   ORDER BY ended_at DESC
   LIMIT 1
   FOR UPDATE;

  IF v_session.id IS NULL THEN
    INSERT INTO presence_sessions (account_id, user_id, status, last_online_at)
    VALUES (v_account_id, auth.uid(), 'online',
            CASE WHEN p_status = 'online' THEN now() END);
    RETURN;
  END IF;

  v_last_online := CASE WHEN p_status = 'online' THEN now() ELSE v_session.last_online_at END;
  UPDATE presence_sessions
     SET ended_at = now(),
         last_online_at = v_last_online,
         online_seconds = online_seconds + CASE
           WHEN v_last_online > now() - interval '45 seconds'
           THEN greatest(0, extract(epoch FROM now() - v_session.ended_at))::int
           ELSE 0 END
   WHERE id = v_session.id;
END;
$$;

-- Online = the counted seconds, pro-rated when a stretch crosses the window.
CREATE OR REPLACE FUNCTION public.team_presence_minutes(
  p_account_id uuid, p_from timestamptz, p_to timestamptz
)
RETURNS TABLE (user_id uuid, online_minutes numeric, away_minutes numeric, first_seen timestamptz, last_seen timestamptz)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public
AS $$
  WITH s AS (
    SELECT user_id, started_at, ended_at, online_seconds,
           extract(epoch FROM ended_at - started_at) AS span,
           extract(epoch FROM least(ended_at, p_to) - greatest(started_at, p_from)) AS inside
      FROM presence_sessions
     WHERE account_id = p_account_id
       AND ended_at > p_from AND started_at < p_to
  )
  SELECT user_id,
         round(sum(CASE WHEN span > 0 THEN online_seconds * inside / span ELSE 0 END) / 60.0, 1),
         round(sum(greatest(inside - CASE WHEN span > 0 THEN online_seconds * inside / span ELSE 0 END, 0)) / 60.0, 1),
         min(greatest(started_at, p_from)),
         max(least(ended_at, p_to))
    FROM s
   GROUP BY user_id
$$;

-- Timeline: one row per connected stretch; amount = minutes online in it.
CREATE OR REPLACE FUNCTION public.member_timeline(
  p_account_id uuid, p_user_id uuid, p_from timestamptz, p_to timestamptz
)
RETURNS TABLE (at timestamptz, kind text, label text, amount numeric, ref_id uuid, ended_at timestamptz)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public
AS $$
  SELECT s.started_at, 'online', NULL::text, round(s.online_seconds / 60.0, 1), NULL::uuid, s.ended_at
    FROM presence_sessions s
   WHERE s.account_id = p_account_id AND s.user_id = p_user_id
     AND s.ended_at > p_from AND s.started_at < p_to
  UNION ALL
  SELECT date_trunc('hour', m.created_at), 'replies', NULL, count(*)::numeric, NULL, NULL
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
   WHERE c.account_id = p_account_id AND m.sender_type = 'agent'
     AND m.sender_id = p_user_id
     AND m.created_at >= p_from AND m.created_at < p_to
   GROUP BY 1
  UNION ALL
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
  SELECT a.created_at, 'appointment', a.title, NULL, a.id, a.starts_at
    FROM appointments a
   WHERE a.account_id = p_account_id AND a.assigned_to = p_user_id
     AND a.created_at >= p_from AND a.created_at < p_to
  UNION ALL
  SELECT n.created_at, 'note', left(n.body, 140), NULL, n.conversation_id, NULL
    FROM conversation_notes n
   WHERE n.account_id = p_account_id AND n.author_user_id = p_user_id
     AND n.created_at >= p_from AND n.created_at < p_to
  ORDER BY 1 DESC
  LIMIT 300
$$;
