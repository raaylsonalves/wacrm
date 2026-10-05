-- ============================================================
-- 105: server-only SECURITY DEFINER functions are no longer callable
--      through PostgREST by anon / authenticated.
--
-- Postgres grants EXECUTE to PUBLIC on every new function, so each of
-- these was reachable at /rest/v1/rpc/<name> with only the public anon
-- key — and, being SECURITY DEFINER, ran with RLS bypassed:
--   - merge_duplicate_contacts / _conversations merge rows across ALL
--     accounts;
--   - _bcast_bump / recompute_broadcast_counts rewrite any broadcast's
--     counters;
--   - claim_ai_reply_slot / claim_waha_send_slot burn another account's
--     AI-reply cap or send slots;
--   - record_webhook_failure can push any endpoint to auto-disable;
--   - notification_* list an account's admin / team user ids.
--
-- Every caller is server-side on the service-role client
-- (auto-reply.ts, waha-throttle.ts, webhooks/deliver.ts, and the trigger
-- functions that call the notification helpers as their owner), so this
-- only closes the public door. Same pattern as migration 037.
-- ============================================================

DO $$
DECLARE
  fn TEXT;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'public._bcast_bump(uuid, text, integer)',
    'public.recompute_broadcast_counts(uuid)',
    'public.claim_ai_reply_slot(uuid, integer)',
    'public.claim_waha_send_slot(uuid, integer)',
    'public.record_webhook_failure(uuid, integer)',
    'public.merge_duplicate_contacts()',
    'public.merge_duplicate_conversations()',
    'public.notification_admins_for(uuid)',
    'public.notification_in_app_enabled(uuid, text)',
    'public.notification_team_for(uuid, uuid)'
  ]
  LOOP
    -- Guarded so a fresh replay where a function was renamed/dropped
    -- doesn't fail the whole migration.
    IF to_regprocedure(fn) IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
    END IF;
  END LOOP;
END $$;
