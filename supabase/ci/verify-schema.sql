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

  -- 062 — without 'openrouter' in both provider CHECKs, saving or
  -- logging usage for an OpenRouter-configured account fails outright.
  IF pg_get_constraintdef(
       (SELECT oid FROM pg_constraint WHERE conname = 'ai_configs_provider_check')
     ) NOT LIKE '%openrouter%' THEN
    RAISE EXCEPTION
      'ai_configs_provider_check does not allow ''openrouter'' — migration 062 did not apply';
  END IF;
  IF pg_get_constraintdef(
       (SELECT oid FROM pg_constraint WHERE conname = 'ai_usage_log_provider_check')
     ) NOT LIKE '%openrouter%' THEN
    RAISE EXCEPTION
      'ai_usage_log_provider_check does not allow ''openrouter'' — migration 062 did not apply';
  END IF;

  -- 063 — the lexical KB search must OR the query's terms, not AND
  -- them, or a real customer question with filler words never matches.
  IF pg_get_functiondef(
       (SELECT oid FROM pg_proc WHERE proname = 'match_ai_knowledge_fts')
     ) NOT LIKE '%string_agg(lexeme%' THEN
    RAISE EXCEPTION
      'match_ai_knowledge_fts still ANDs every term — migration 063 did not apply';
  END IF;

  -- 064 — the WAHA send throttle's claim is only correct under
  -- concurrent invocations if last_sent_at exists and the RPC is the
  -- installed atomic UPDATE...WHERE...RETURNING; a missing column or
  -- a silently-reverted function body would mean sends go out
  -- unthrottled with no error anywhere.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'whatsapp_waha_channels'
      AND column_name = 'last_sent_at'
  ) THEN
    RAISE EXCEPTION
      'whatsapp_waha_channels.last_sent_at is missing — migration 064 did not apply';
  END IF;
  IF pg_get_functiondef(
       'public.claim_waha_send_slot(uuid,integer)'::regprocedure
     ) NOT LIKE '%RETURNING 1%' THEN
    RAISE EXCEPTION
      'claim_waha_send_slot is missing its atomic claim — migration 064 did not apply';
  END IF;

  -- 065 — audit_log's entire value proposition over a plain log table
  -- is that even a leaked service_role key can't erase its own trail.
  -- A silently-skipped REVOKE (this file's own CREATE-TABLE-default-
  -- ACL trap, called out in the migration's own header) would leave
  -- that guarantee false while everything else about the table looks
  -- fine.
  IF to_regclass('public.audit_log') IS NULL THEN
    RAISE EXCEPTION 'public.audit_log is missing — migration 065 did not apply';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
    WHERE table_schema = 'public' AND table_name = 'audit_log'
      AND grantee IN ('anon', 'authenticated', 'service_role')
      AND privilege_type IN ('UPDATE', 'DELETE', 'TRUNCATE')
  ) THEN
    RAISE EXCEPTION
      'audit_log still has UPDATE/DELETE/TRUNCATE grants — migration 065 REVOKE did not apply';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'audit_log'
      AND policyname = 'audit_log_select'
  ) THEN
    RAISE EXCEPTION 'audit_log_select RLS policy is missing — migration 065 did not apply';
  END IF;

  -- 066 — multi-agent + router. The UNIQUE(account_id) drop and the
  -- partial unique index are both load-bearing: without the drop, a
  -- 2nd ai_configs insert for the same account 23505s; without the
  -- index, two rows could both claim is_default and every caller that
  -- assumes exactly one (loadAiConfig's default lookup) would break in
  -- a way that only shows up once an account actually creates a 2nd
  -- agent, not at migration time.
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ai_configs_account_id_key'
  ) THEN
    RAISE EXCEPTION
      'ai_configs_account_id_key still exists — migration 066 did not apply';
  END IF;
  IF to_regclass('public.idx_ai_configs_account_default') IS NULL THEN
    RAISE EXCEPTION
      'idx_ai_configs_account_default is missing — migration 066 did not apply';
  END IF;
  IF to_regclass('public.ai_routers') IS NULL
     OR to_regclass('public.ai_router_members') IS NULL THEN
    RAISE EXCEPTION 'ai_routers/ai_router_members are missing — migration 066 did not apply';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'conversations'
      AND column_name = 'active_ai_agent_id'
  ) THEN
    RAISE EXCEPTION
      'conversations.active_ai_agent_id is missing — migration 066 did not apply';
  END IF;

  -- 067 — onboarding wizard. Missing onboarded_at would make the
  -- "never redirect an already-onboarded account back into the
  -- wizard" guarantee unenforceable, silently.
  IF (
    SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'accounts'
      AND column_name IN ('onboarding_state', 'onboarded_at')
  ) <> 2 THEN
    RAISE EXCEPTION
      'accounts.onboarding_state/onboarded_at are missing — migration 067 did not apply';
  END IF;

  -- 068 — broadcast channel rotation. The 9-arg overload replacing
  -- the 8-arg one is the part most likely to silently half-apply (the
  -- DROP could succeed while the CREATE fails, or vice versa) —
  -- assert the NEW signature resolves and the OLD one is gone, not
  -- just that "a" create_broadcast_with_recipients exists.
  IF NOT (
    SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'broadcasts'
      AND column_name = 'primary_channel_id'
  ) = 1 THEN
    RAISE EXCEPTION
      'broadcasts.primary_channel_id is missing — migration 068 did not apply';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'broadcast_recipients'
      AND column_name = 'sent_via_channel_id'
  ) THEN
    RAISE EXCEPTION
      'broadcast_recipients.sent_via_channel_id is missing — migration 068 did not apply';
  END IF;
  IF to_regclass('public.broadcast_channel_pool') IS NULL THEN
    RAISE EXCEPTION 'broadcast_channel_pool is missing — migration 068 did not apply';
  END IF;
  IF to_regprocedure(
       'public.create_broadcast_with_recipients(uuid,uuid,text,text,text,integer,uuid[],jsonb[],uuid)'
     ) IS NULL THEN
    RAISE EXCEPTION
      'create_broadcast_with_recipients 9-arg overload is missing — migration 068 did not apply';
  END IF;
  IF to_regprocedure(
       'public.create_broadcast_with_recipients(uuid,uuid,text,text,text,integer,uuid[],jsonb[])'
     ) IS NOT NULL THEN
    RAISE EXCEPTION
      'create_broadcast_with_recipients 8-arg overload still exists — migration 068''s DROP did not apply';
  END IF;

  -- 069 — per-channel responsible agents. The enforcement trigger is
  -- the part that actually matters (the tables alone don't stop a
  -- forged assignment) — assert it, not just the tables under it.
  IF to_regclass('public.channel_routing_policies') IS NULL THEN
    RAISE EXCEPTION
      'channel_routing_policies is missing — migration 069 did not apply';
  END IF;
  IF to_regclass('public.channel_routing_responsibles') IS NULL THEN
    RAISE EXCEPTION
      'channel_routing_responsibles is missing — migration 069 did not apply';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_enforce_channel_routing'
      AND tgrelid = 'public.conversations'::regclass
  ) THEN
    RAISE EXCEPTION
      'trg_enforce_channel_routing is missing on conversations — migration 069 did not apply';
  END IF;

  -- 070 — inbox power features. The un-snooze-on-inbound lives inside
  -- a CREATE OR REPLACE of bump_conversation_on_inbound, which would
  -- "succeed" silently if replaced by an older body — assert the
  -- function actually references snoozed_until.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'conversations'
      AND column_name = 'snoozed_until'
  ) THEN
    RAISE EXCEPTION 'conversations.snoozed_until is missing — migration 070 did not apply';
  END IF;
  IF to_regclass('public.conversation_tags') IS NULL THEN
    RAISE EXCEPTION 'conversation_tags is missing — migration 070 did not apply';
  END IF;
  IF to_regclass('public.conversation_notes') IS NULL THEN
    RAISE EXCEPTION 'conversation_notes is missing — migration 070 did not apply';
  END IF;
  IF position('snoozed_until' IN pg_get_functiondef(
       'public.bump_conversation_on_inbound(uuid,text)'::regprocedure
     )) = 0 THEN
    RAISE EXCEPTION
      'bump_conversation_on_inbound does not clear snoozed_until — migration 070 did not apply';
  END IF;

  -- 071 — Web Push subscriptions. `endpoint` UNIQUE is the upsert key
  -- the subscribe route's ON CONFLICT depends on; without it every
  -- re-save would insert a duplicate and the device gets N pushes.
  IF to_regclass('public.push_subscriptions') IS NULL THEN
    RAISE EXCEPTION 'push_subscriptions is missing — migration 071 did not apply';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.push_subscriptions'::regclass
      AND contype = 'u'
      AND pg_get_constraintdef(oid) = 'UNIQUE (endpoint)'
  ) THEN
    RAISE EXCEPTION 'push_subscriptions.endpoint is not UNIQUE — migration 071 did not apply';
  END IF;

  -- 072 — AI handoff reason. The CHECK is what keeps a typo'd reason
  -- from being stored; the columns are what the banner reads.
  IF (SELECT count(*) FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'conversations'
        AND column_name IN ('ai_handoff_reason', 'ai_handoff_meta',
                            'ai_handoff_customer_notified',
                            'ai_handoff_notice_skipped_reason')) <> 4 THEN
    RAISE EXCEPTION 'conversations.ai_handoff_* columns are missing — migration 072 did not apply';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.conversations'::regclass
      AND conname = 'conversations_ai_handoff_reason_check'
  ) THEN
    RAISE EXCEPTION 'conversations_ai_handoff_reason_check is missing — migration 072 did not apply';
  END IF;

  -- 073 — follow-up sequences. The UNIQUE key IS the enrollment claim
  -- (ON CONFLICT DO NOTHING is how overlapping sweeps avoid double
  -- enrolling); the widened status CHECK is what lets a parked wait be
  -- cancelled; and bump_conversation_on_inbound was redefined AGAIN, so
  -- it must still carry 070's snoozed_until along with the new markers.
  IF to_regclass('public.followup_enrollments') IS NULL
     OR to_regclass('public.followup_sends') IS NULL THEN
    RAISE EXCEPTION 'followup tables are missing — migration 073 did not apply';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.followup_enrollments'::regclass
      AND contype = 'u'
      AND pg_get_constraintdef(oid) =
          'UNIQUE (automation_id, conversation_id, episode_at)'
  ) THEN
    RAISE EXCEPTION 'followup_enrollments claim key is missing — migration 073 did not apply';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.automation_pending_executions'::regclass
      AND conname = 'automation_pending_executions_status_check'
      AND position('cancelled' IN pg_get_constraintdef(oid)) > 0
  ) THEN
    RAISE EXCEPTION 'automation_pending_executions status CHECK does not allow cancelled — migration 073 did not apply';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'conversations'
      AND column_name = 'last_customer_message_at'
  ) THEN
    RAISE EXCEPTION 'conversations.last_customer_message_at is missing — migration 073 did not apply';
  END IF;
  IF position('last_customer_message_at' IN pg_get_functiondef(
       'public.bump_conversation_on_inbound(uuid,text)'::regprocedure
     )) = 0
     OR position('snoozed_until' IN pg_get_functiondef(
       'public.bump_conversation_on_inbound(uuid,text)'::regprocedure
     )) = 0
     OR position('cancel_followups' IN pg_get_functiondef(
       'public.bump_conversation_on_inbound(uuid,text)'::regprocedure
     )) = 0 THEN
    RAISE EXCEPTION 'bump_conversation_on_inbound lost a 070/073 marker — a later redefinition dropped it';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_followups_on_conversation_change')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_followups_on_contact_opt_out') THEN
    RAISE EXCEPTION 'follow-up stop triggers are missing — migration 073 did not apply';
  END IF;

  -- 074 — manageable AI agents. The expression UNIQUE index is what makes
  -- "one agent per number" true INCLUDING the Cloud API slot (channel_id
  -- NULL — a plain UNIQUE treats NULLs as distinct); the scope trigger is
  -- what stops a forged agent_id from binding another account's agent (and
  -- key) to this account's number.
  IF to_regclass('public.ai_channel_agents') IS NULL THEN
    RAISE EXCEPTION 'ai_channel_agents is missing — migration 074 did not apply';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'idx_ai_channel_agents_channel'
      AND indexdef LIKE '%UNIQUE%' AND indexdef LIKE '%coalesce%'
  ) THEN
    RAISE EXCEPTION 'ai_channel_agents one-agent-per-number index is missing — migration 074 did not apply';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_ai_channel_agent_scope') THEN
    RAISE EXCEPTION 'ai_channel_agents scope trigger is missing — migration 074 did not apply';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'ai_usage_log' AND column_name = 'agent_id'
  ) THEN
    RAISE EXCEPTION 'ai_usage_log.agent_id is missing — migration 074 did not apply';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'ai_configs' AND column_name = 'handoff_keywords'
  ) THEN
    RAISE EXCEPTION 'ai_configs.handoff_keywords is missing — migration 074 did not apply';
  END IF;
  IF to_regclass('public.ai_guardrail_traces') IS NULL THEN
    RAISE EXCEPTION 'ai_guardrail_traces is missing — migration 075 did not apply';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'messages' AND column_name = 'transcript_status'
  ) THEN
    RAISE EXCEPTION 'messages.transcript_status is missing — migration 076 did not apply';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'ai_configs' AND column_name = 'transcription_model'
  ) THEN
    RAISE EXCEPTION 'ai_configs.transcription_model is missing — migration 077 did not apply';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'ai_usage_log' AND column_name = 'cached_tokens'
  ) THEN
    RAISE EXCEPTION 'ai_usage_log.cached_tokens is missing — migration 078 did not apply';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'ai_configs' AND column_name = 'voice_reply_mode'
  ) THEN
    RAISE EXCEPTION 'ai_configs.voice_reply_mode is missing — migration 079 did not apply';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'ai_usage_log' AND column_name = 'speech_chars'
  ) THEN
    RAISE EXCEPTION 'ai_usage_log.speech_chars is missing — migration 080 did not apply';
  END IF;
  IF to_regclass('public.notification_types') IS NULL OR to_regclass('public.notification_preferences') IS NULL THEN
    RAISE EXCEPTION 'notification catalogue/preferences missing — migration 086 did not apply';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'notifications' AND column_name = 'group_key'
  ) OR to_regprocedure('public.upsert_notification(uuid,uuid,text,uuid,uuid,uuid,text,text,text,text,jsonb,text,text)') IS NULL THEN
    RAISE EXCEPTION 'notification grouping missing — migration 086 did not apply';
  END IF;
  IF to_regclass('public.human_cases') IS NULL OR to_regclass('public.human_case_events') IS NULL THEN
    RAISE EXCEPTION 'human_cases tables are missing — migration 085 did not apply';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'notifications_type_check' AND pg_get_constraintdef(oid) LIKE '%case_opened%'
  ) THEN
    RAISE EXCEPTION 'notifications type check lacks case types — migration 085 did not apply';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'contacts' AND column_name = 'avatar_updated_at'
  ) THEN
    RAISE EXCEPTION 'contacts.avatar_updated_at is missing — migration 084 did not apply';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'prospecting_candidates' AND column_name = 'followups_sent'
  ) THEN
    RAISE EXCEPTION 'prospecting_candidates.followups_sent is missing — migration 083 did not apply';
  END IF;
  IF to_regclass('public.prospecting_campaigns') IS NULL
     OR to_regclass('public.prospecting_candidates') IS NULL THEN
    RAISE EXCEPTION 'prospecting tables are missing — migration 082 did not apply';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'conversations' AND column_name = 'pinned_ai_agent_id'
  ) THEN
    RAISE EXCEPTION 'conversations.pinned_ai_agent_id is missing — migration 082 did not apply';
  END IF;
  IF to_regclass('public.contact_imports') IS NULL
     OR to_regclass('public.contact_import_errors') IS NULL THEN
    RAISE EXCEPTION 'contact_imports tables are missing — migration 081 did not apply';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'contacts' AND column_name = 'consent_basis'
  ) THEN
    RAISE EXCEPTION 'contacts.consent_basis is missing — migration 081 did not apply';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'conversations_ai_handoff_reason_check'
      AND pg_get_constraintdef(oid) LIKE '%audio_unintelligible%'
  ) THEN
    RAISE EXCEPTION 'handoff reason check does not allow audio_unintelligible — migration 076 did not apply';
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
