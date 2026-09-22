-- ============================================================
-- 057_fix_deal_trigger_search_path.sql — pin search_path on the
-- deal-position trigger function.
--
-- fn_deal_default_position_in_stage (migration 055) was created
-- without an explicit search_path, so Postgres resolves its
-- unqualified `deals` reference against whatever search_path is in
-- effect at call time (session-mutable) rather than a fixed schema —
-- flagged by Supabase's linter (function_search_path_mutable). Pin it
-- the same way the other trigger functions in this schema should be,
-- closing the "search_path could be hijacked by a role that can set
-- it" class of issue. No behavior change: `public` is already the
-- only schema this function touches.
--
-- Idempotent — ALTER FUNCTION ... SET is safe to run multiple times.
-- ============================================================

ALTER FUNCTION public.fn_deal_default_position_in_stage()
  SET search_path = public;
