-- ============================================================
-- 067_onboarding_state.sql — post-signup onboarding wizard
-- (specs/signup-onboarding-wizard.md).
--
-- `onboarding_state` holds one entry per step, keyed by segment:
-- `{ "channel": { "done": true }, "ai-agent": { "done": true,
-- "skipped": false } }` — read/written by src/lib/onboarding/steps.ts,
-- never queried by column (jsonb, not normalized) since the step list
-- itself is expected to change shape over time without a migration.
--
-- `onboarded_at` is the ONE fact that matters for "does this account
-- see the wizard again": set on reaching /onboarding/done OR on the
-- explicit "skip onboarding" link — both are terminal, and a NULL
-- value is the only thing gating a redirect into /onboarding for an
-- existing account.
--
-- Existing accounts get `onboarded_at` backfilled to `now()`
-- (Non-goals: "Migrar contas existentes... continuam como estão — sem
-- onboarding retroativo forçado") — without this backfill, EVERY
-- account created before this migration would be redirected into the
-- wizard on its members' next login, which is exactly the forced
-- retroactive onboarding the spec rules out.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS onboarding_state jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS onboarded_at timestamptz;

UPDATE accounts SET onboarded_at = now() WHERE onboarded_at IS NULL;
