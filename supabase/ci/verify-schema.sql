-- Post-migration assertions for the CI job in
-- `.github/workflows/migrations.yml`.
--
-- `supabase db reset` already fails on any statement Postgres rejects,
-- so this is not about syntax. It's about the quieter failure: a
-- migration that applies cleanly and does nothing. Every DDL statement
-- in this repo is guarded with IF NOT EXISTS / ON CONFLICT so the files
-- can be re-run safely, and that same guard turns a typo'd object name
-- into a silent no-op with a green checkmark.
--
-- Keep this thin. It is a smoke test for "did the migrations actually
-- build the schema", not a spec of it — asserting every column here
-- would just be the migrations restated in a second place, drifting.
DO $$
BEGIN
  -- The core tables, from 001.
  IF to_regclass('public.messages') IS NULL THEN
    RAISE EXCEPTION 'public.messages is missing — migrations did not apply';
  END IF;
  IF to_regclass('public.whatsapp_config') IS NULL THEN
    RAISE EXCEPTION 'public.whatsapp_config is missing — migrations did not apply';
  END IF;

  -- Supabase provides the storage schema; migrations 016/020/023 write
  -- to it. If it is absent the bucket migrations silently accomplish
  -- nothing, which is precisely the case a plain "no errors" run hides.
  IF to_regclass('storage.buckets') IS NULL THEN
    RAISE EXCEPTION
      'storage.buckets is missing — the storage schema was not available when the bucket migrations ran';
  END IF;

  -- Buckets are UPSERTed, so their absence means the INSERT never ran.
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'chat-media') THEN
    RAISE EXCEPTION 'the chat-media bucket row was not created (migration 023)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'flow-media') THEN
    RAISE EXCEPTION 'the flow-media bucket row was not created (migration 016)';
  END IF;

  -- Account scoping (017) is load-bearing for every RLS policy.
  IF to_regclass('public.accounts') IS NULL THEN
    RAISE EXCEPTION 'public.accounts is missing — migration 017 did not apply';
  END IF;

  -- The BSUID index (040) is the only thing stopping a username-only
  -- WhatsApp sender from forking a new contact per inbound message. A
  -- typo in its name would apply cleanly and guarantee nothing.
  IF to_regclass('public.idx_contacts_account_wa_user_id') IS NULL THEN
    RAISE EXCEPTION
      'idx_contacts_account_wa_user_id is missing — migration 040 did not apply';
  END IF;

  -- Opt-out flag (053) — broadcasts and automations both depend on
  -- this column existing to skip contacts who asked to stop.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'contacts'
      AND column_name = 'opted_out_at'
  ) THEN
    RAISE EXCEPTION 'contacts.opted_out_at is missing — migration 053 did not apply';
  END IF;

  -- LGPD anonymization flag (054) — the anonymize endpoint depends on
  -- this column existing to mark a contact as scrubbed.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'contacts'
      AND column_name = 'anonymized_at'
  ) THEN
    RAISE EXCEPTION 'contacts.anonymized_at is missing — migration 054 did not apply';
  END IF;

  -- Deal card ordering (055) — the trigger is what makes every insert
  -- path (deal form, automations' create_deal step) get a sane default
  -- position without each of them having to compute one.
  IF to_regclass('public.idx_deals_stage_position') IS NULL THEN
    RAISE EXCEPTION 'idx_deals_stage_position is missing — migration 055 did not apply';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_deal_default_position_in_stage'
  ) THEN
    RAISE EXCEPTION
      'trg_deal_default_position_in_stage is missing — migration 055 did not apply';
  END IF;

  -- WAHA channels (056) — a typo'd table/column name here would apply
  -- cleanly and leave the connect flow silently unable to save a channel.
  IF to_regclass('public.whatsapp_waha_channels') IS NULL THEN
    RAISE EXCEPTION 'public.whatsapp_waha_channels is missing — migration 056 did not apply';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'conversations'
      AND column_name = 'whatsapp_channel_id'
  ) THEN
    RAISE EXCEPTION
      'conversations.whatsapp_channel_id is missing — migration 056 did not apply';
  END IF;
  IF to_regclass('public.idx_waha_channels_session') IS NULL THEN
    RAISE EXCEPTION
      'idx_waha_channels_session is missing — migration 056 did not apply, WAHA channel creation is unprotected against duplicate session names';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'whatsapp_waha_channels'
      AND policyname = 'waha_channels_select'
  ) THEN
    RAISE EXCEPTION
      'waha_channels_select RLS policy is missing — migration 056 did not apply';
  END IF;

  -- Deal trigger search_path pin (057) — closes the
  -- function_search_path_mutable lint; a no-op ALTER FUNCTION that
  -- silently didn't apply would leave the function resolvable against
  -- a caller-controlled search_path again.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE proname = 'fn_deal_default_position_in_stage'
      AND 'search_path=public' = ANY(proconfig)
  ) THEN
    RAISE EXCEPTION
      'fn_deal_default_position_in_stage search_path is not pinned — migration 057 did not apply';
  END IF;

  -- Appointments (058) — the exclusion constraint is what stops the
  -- offer_slots flow node from double-booking a slot under concurrent
  -- taps; a silently-skipped DO block would leave that race open.
  IF to_regclass('public.appointments') IS NULL
     OR to_regclass('public.appointment_settings') IS NULL THEN
    RAISE EXCEPTION 'appointments tables are missing — migration 058 did not apply';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'appointments_no_overlap'
  ) THEN
    RAISE EXCEPTION 'appointments_no_overlap is missing — migration 058 did not apply';
  END IF;
  -- 059 — without this, the same contact can be double-booked across
  -- two different calendars (an agent's + the shared one) at once.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'appointments_no_contact_overlap'
  ) THEN
    RAISE EXCEPTION 'appointments_no_contact_overlap is missing — migration 059 did not apply';
  END IF;
  IF pg_get_constraintdef(
       (SELECT oid FROM pg_constraint WHERE conname = 'flow_nodes_node_type_check')
     ) NOT LIKE '%offer_slots%' THEN
    RAISE EXCEPTION 'flow_nodes.node_type does not allow offer_slots — migration 058 did not apply';
  END IF;

  -- 041 repairs create_broadcast_with_recipients, which 037/038 shipped
  -- with an ambiguous bare `RETURNING id, contact_id` (SQLSTATE 42702 on
  -- first call — plpgsql resolves names at execution, not CREATE, so a
  -- plain replay can't catch it). Assert the qualified form is what's
  -- actually installed.
  IF pg_get_functiondef(
       'public.create_broadcast_with_recipients(uuid,uuid,text,text,text,integer,uuid[],jsonb[])'::regprocedure
     ) NOT LIKE '%RETURNING id, broadcast_recipients.contact_id%' THEN
    RAISE EXCEPTION
      'create_broadcast_with_recipients still has the ambiguous RETURNING — migration 041 did not apply';
  END IF;

  -- The failure-reason columns (042) are only ever written by the
  -- status webhook, which uses an untyped update — a missing column
  -- there is a runtime PostgREST error on every failed send, not a
  -- compile error.
  IF (
    SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'messages'
      AND column_name IN ('error_code', 'error_title', 'error_details')
  ) <> 3 THEN
    RAISE EXCEPTION
      'messages.error_code/error_title/error_details are missing — migration 042 did not apply';
  END IF;

  -- Branding columns (044) — see specs/account-branding.md. Nullable,
  -- so their absence wouldn't break anything visibly; it would just
  -- mean Settings > Branding writes 400 forever.
  IF (
    SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'accounts'
      AND column_name IN ('display_name', 'logo_url', 'brand_color')
  ) <> 3 THEN
    RAISE EXCEPTION
      'accounts.display_name/logo_url/brand_color are missing — migration 044 did not apply';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'account-logos') THEN
    RAISE EXCEPTION 'the account-logos bucket row was not created (migration 044)';
  END IF;

  -- 043 swaps the `pipelines` existence check inside redeem_invitation
  -- for a `deals` check — a client-seeded empty "Sales Pipeline" (no
  -- trigger involved) otherwise false-positives as "has data" and
  -- blocks legitimate invite acceptance. Assert the fixed body is
  -- actually installed, not the pre-043 one.
  IF pg_get_functiondef('public.redeem_invitation(text)'::regprocedure)
       LIKE '%UNION ALL SELECT 1 FROM pipelines WHERE account_id%' THEN
    RAISE EXCEPTION
      'redeem_invitation still checks pipelines instead of deals — migration 043 did not apply';
  END IF;

  -- 047 replaced 044's account-logos storage policies to stop casting
  -- an arbitrary path segment to uuid (which throws 22P02 on any other
  -- bucket's non-uuid-prefixed paths, e.g. flow-media's
  -- 'account-<uuid>', if Postgres ever evaluates that qual before the
  -- bucket_id check). A missing/reverted policy body is a silent
  -- correctness change, not a compile error.
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'Admins can upload their account logo'
      AND with_check LIKE '%::uuid%'
  ) THEN
    RAISE EXCEPTION
      'account-logos upload policy still casts the path segment to uuid — migration 047 did not apply';
  END IF;

  -- 046 lets the cron reclaim a pending execution stuck at 'running'
  -- (a died-mid-resume process otherwise parks it forever, since only
  -- 'pending' rows are ever re-queried). Missing this column is a
  -- silent no-op, not a compile error, on the cron's next deploy.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'automation_pending_executions'
      AND column_name = 'claimed_at'
  ) THEN
    RAISE EXCEPTION
      'automation_pending_executions.claimed_at is missing — migration 046 did not apply';
  END IF;

  -- 045 closes the same column-level privilege hole 034 closed on
  -- profiles, but on accounts.owner_user_id — without this trigger any
  -- admin (not just the owner) can PATCH their way to ownership
  -- directly through PostgREST, since accounts_update RLS is row-level
  -- only. A missing trigger here is invisible until someone exploits it.
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'enforce_account_owner_column'
      AND tgrelid = 'public.accounts'::regclass
      AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION
      'enforce_account_owner_column trigger is missing on accounts — migration 045 did not apply';
  END IF;

  -- 048 stops notify_conversation_assigned() from writing a pre-rendered
  -- English sentence into title/body — it now hands the raw actor/contact
  -- names to the client, which builds the sentence in the app locale.
  -- Missing these columns is a silent no-op on the trigger's INSERT, not
  -- a compile error.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'notifications'
      AND column_name = 'actor_name'
  ) THEN
    RAISE EXCEPTION
      'notifications.actor_name is missing — migration 048 did not apply';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'notifications'
      AND column_name = 'contact_name'
  ) THEN
    RAISE EXCEPTION
      'notifications.contact_name is missing — migration 048 did not apply';
  END IF;

  -- 049 gives the dashboard's response-time "target" pill somewhere to
  -- be configured — before it, `thresholdMinutes` was a component prop
  -- nobody ever passed. Missing this column is a silent no-op on the
  -- settings save, not a compile error.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'accounts'
      AND column_name = 'response_time_target_minutes'
  ) THEN
    RAISE EXCEPTION
      'accounts.response_time_target_minutes is missing — migration 049 did not apply';
  END IF;

  -- 051 lets the inbox show a live per-conversation SLA indicator by
  -- telling "still waiting on us" apart from "we already replied"
  -- without a join. A guarded ADD COLUMN IF NOT EXISTS is a silent
  -- no-op on a typo'd name, so verify it landed.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'conversations'
      AND column_name = 'last_message_sender_type'
  ) THEN
    RAISE EXCEPTION
      'conversations.last_message_sender_type is missing — migration 051 did not apply';
  END IF;

  -- 052 lets an account configure fallback provider/model tiers for AI
  -- auto-reply, tried in order when the primary one fails.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'ai_configs'
      AND column_name = 'fallbacks'
  ) THEN
    RAISE EXCEPTION
      'ai_configs.fallbacks is missing — migration 052 did not apply';
  END IF;

  -- 060 gates the AI auto-reply agenda tools (offer_slots /
  -- book_appointment) behind a per-account opt-in.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'ai_configs'
      AND column_name = 'agenda_enabled'
  ) THEN
    RAISE EXCEPTION
      'ai_configs.agenda_enabled is missing — migration 060 did not apply';
  END IF;

  -- 061 — without 'ai' in the allowed source values, the AI's
  -- book_appointment tool can't insert a row at all.
  IF pg_get_constraintdef(
       (SELECT oid FROM pg_constraint WHERE conname = 'appointments_source_check')
     ) NOT LIKE '%''ai''%' THEN
    RAISE EXCEPTION
      'appointments_source_check does not allow ''ai'' — migration 061 did not apply';
  END IF;

  RAISE NOTICE 'schema verification passed';
END
$$;

-- Two things this file has already been burned by, both verified in CI
-- rather than assumed:
--
-- 1. It must contain EXACTLY ONE statement. `supabase db query --file`
--    sends the whole file as a prepared statement, and a second
--    top-level statement fails with the distinctly unhelpful "cannot
--    insert multiple commands into a prepared statement" (commit
--    f91a6c8). Add assertions INSIDE the DO block above; do not append
--    a second one.
--
-- 2. A RAISE in here really does fail the job. A deliberately false
--    assertion (commit 42c7db0, run 31579334056) surfaced as
--    `failed to execute query: error: ...` and exited 1. This is not a
--    decorative green tick.
