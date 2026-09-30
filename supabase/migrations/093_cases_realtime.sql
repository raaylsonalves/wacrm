-- 093_cases_realtime.sql
--
-- The cases screen refreshes itself when a case is opened, answered or
-- closed (by the AI, a teammate or the customer's reply) instead of only
-- on reload. Realtime applies the table's RLS, so a member only receives
-- their own account's cases.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (
       SELECT 1 FROM pg_publication_tables
       WHERE pubname = 'supabase_realtime' AND tablename = 'human_cases'
     ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE human_cases;
  END IF;
END $$;
