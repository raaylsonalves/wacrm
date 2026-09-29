-- ============================================================
-- 073_followup_sequences.sql — follow-up sequences on the automations
-- engine (specs/followup-sequences.md).
--
-- A lead that stops answering is a lost sale nobody notices. The
-- automations engine already has durable waits; what it lacked was
--   (a) a trigger for "this conversation went silent", and
--   (b) a way to CANCEL a parked wait when the customer finally
--       replies, a human takes over, the thread closes or the contact
--       opts out — without (b), "wait 1 day then nudge" texts a
--       customer who answered five minutes after it was armed.
--
-- Additive: an account with no follow-up automation sees no change.
-- The trigger is `automations.trigger_type = 'conversation_silence'`
-- (a text column, no CHECK) — there is deliberately no `kind` column:
-- it would be a second truth for what the trigger already says.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ---- 1. Episode anchor --------------------------------------------
-- A new silence "episode" begins only when the CUSTOMER speaks again.
-- Our own follow-ups change last_message_at, so keying on it would
-- re-enroll the same conversation forever.
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS last_customer_message_at timestamptz;

UPDATE conversations c
SET last_customer_message_at = m.last_at
FROM (
  SELECT conversation_id, max(created_at) AS last_at
  FROM messages
  WHERE sender_type = 'customer'
  GROUP BY conversation_id
) m
WHERE m.conversation_id = c.id
  AND c.last_customer_message_at IS NULL;

-- ---- 2. Enrollments -----------------------------------------------
CREATE TABLE IF NOT EXISTS followup_enrollments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  automation_id   uuid NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  contact_id      uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  episode_at      timestamptz NOT NULL,   -- = last_customer_message_at
  status          text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'completed', 'cancelled')),
  outcome         text CHECK (outcome IN (
    'replied', 'exhausted', 'handoff', 'opted_out', 'closed',
    'window_closed', 'frequency_cap', 'automation_off', 'not_deliverable'
  )),
  steps_sent      smallint NOT NULL DEFAULT 0,
  started_at      timestamptz NOT NULL DEFAULT now(),
  ended_at        timestamptz,
  -- The unique key IS the claim: one enrollment per (sequence,
  -- conversation, episode). INSERT ... ON CONFLICT DO NOTHING
  -- RETURNING is how two overlapping sweeps avoid double-enrolling.
  UNIQUE (automation_id, conversation_id, episode_at)
);
CREATE INDEX IF NOT EXISTS idx_followup_enrollments_active
  ON followup_enrollments (conversation_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_followup_enrollments_contact_active
  ON followup_enrollments (contact_id) WHERE status = 'active';

ALTER TABLE followup_enrollments ENABLE ROW LEVEL SECURITY;
-- Members read; every write is service-role (the sweep) or one of the
-- SECURITY DEFINER functions below (same shape as audit_log).
DROP POLICY IF EXISTS followup_enrollments_select ON followup_enrollments;
CREATE POLICY followup_enrollments_select ON followup_enrollments
  FOR SELECT USING (is_account_member(account_id));

-- One row per follow-up message actually sent: the per-contact
-- frequency cap counts these across ALL sequences, so two overlapping
-- sequences can't double-nudge the same person.
CREATE TABLE IF NOT EXISTS followup_sends (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  enrollment_id uuid NOT NULL REFERENCES followup_enrollments(id) ON DELETE CASCADE,
  contact_id    uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  sent_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_followup_sends_contact
  ON followup_sends (contact_id, sent_at DESC);

ALTER TABLE followup_sends ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS followup_sends_select ON followup_sends;
CREATE POLICY followup_sends_select ON followup_sends
  FOR SELECT USING (is_account_member(account_id));

-- ---- 3. Parked waits can be cancelled -----------------------------
ALTER TABLE automation_pending_executions
  ADD COLUMN IF NOT EXISTS enrollment_id uuid
    REFERENCES followup_enrollments(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_pending_executions_enrollment
  ON automation_pending_executions (enrollment_id)
  WHERE enrollment_id IS NOT NULL;

-- Widen the status CHECK (additive: existing rows keep their values).
ALTER TABLE automation_pending_executions
  DROP CONSTRAINT IF EXISTS automation_pending_executions_status_check;
ALTER TABLE automation_pending_executions
  ADD CONSTRAINT automation_pending_executions_status_check
  CHECK (status IN ('pending', 'running', 'done', 'failed', 'cancelled'));

-- ---- 4. Cancelling ------------------------------------------------
-- The stop conditions live in Postgres because dashboard writes
-- (closing a thread, assigning, opting out) go browser → RLS with no
-- server hop — the same constraint that put channel routing in a
-- trigger (migration 069). The engine's send-time re-check remains the
-- source of truth; these are the cleanup that keeps the queue honest.
--
-- 'handoff' honours the sequence's `handoff_policy` (default cancel):
-- a sequence configured `allow` keeps going after a human is assigned.
CREATE OR REPLACE FUNCTION public.cancel_followups(
  p_conversation_id uuid,
  p_reason text
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH target AS (
    SELECT e.id
    FROM followup_enrollments e
    JOIN automations a ON a.id = e.automation_id
    WHERE e.conversation_id = p_conversation_id
      AND e.status = 'active'
      AND (p_reason <> 'handoff'
           OR coalesce(a.trigger_config->>'handoff_policy', 'cancel') = 'cancel')
  ), parked AS (
    UPDATE automation_pending_executions
    SET status = 'cancelled'
    WHERE enrollment_id IN (SELECT id FROM target)
      AND status = 'pending'
    RETURNING 1
  )
  UPDATE followup_enrollments
  SET status = 'cancelled', outcome = p_reason, ended_at = now()
  WHERE id IN (SELECT id FROM target);
$$;

CREATE OR REPLACE FUNCTION public.cancel_followups_for_contact(
  p_contact_id uuid,
  p_reason text
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH target AS (
    SELECT id FROM followup_enrollments
    WHERE contact_id = p_contact_id AND status = 'active'
  ), parked AS (
    UPDATE automation_pending_executions
    SET status = 'cancelled'
    WHERE enrollment_id IN (SELECT id FROM target)
      AND status = 'pending'
    RETURNING 1
  )
  UPDATE followup_enrollments
  SET status = 'cancelled', outcome = p_reason, ended_at = now()
  WHERE id IN (SELECT id FROM target);
$$;

-- Internal helpers: never callable by API users.
REVOKE ALL ON FUNCTION public.cancel_followups(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cancel_followups_for_contact(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_followups(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.cancel_followups_for_contact(uuid, text) TO service_role;

-- Triggers run as the table owner's SECURITY DEFINER wrappers, so the
-- REVOKE above doesn't stop them (the wrapper functions are DEFINER too).
CREATE OR REPLACE FUNCTION public.trg_followups_on_conversation_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status = 'closed' AND OLD.status IS DISTINCT FROM 'closed' THEN
    PERFORM public.cancel_followups(NEW.id, 'closed');
  ELSIF NEW.assigned_agent_id IS NOT NULL
        AND NEW.assigned_agent_id IS DISTINCT FROM OLD.assigned_agent_id THEN
    PERFORM public.cancel_followups(NEW.id, 'handoff');
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_followups_on_conversation_change ON conversations;
CREATE TRIGGER trg_followups_on_conversation_change
  AFTER UPDATE OF status, assigned_agent_id ON conversations
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status
        OR OLD.assigned_agent_id IS DISTINCT FROM NEW.assigned_agent_id)
  EXECUTE FUNCTION public.trg_followups_on_conversation_change();

CREATE OR REPLACE FUNCTION public.trg_followups_on_contact_opt_out()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.cancel_followups_for_contact(NEW.id, 'opted_out');
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_followups_on_contact_opt_out ON contacts;
CREATE TRIGGER trg_followups_on_contact_opt_out
  AFTER UPDATE OF opted_out_at ON contacts
  FOR EACH ROW
  WHEN (OLD.opted_out_at IS NULL AND NEW.opted_out_at IS NOT NULL)
  EXECUTE FUNCTION public.trg_followups_on_contact_opt_out();

-- ---- 5. Inbound: stamp the episode + cancel on reply --------------
-- CREATE OR REPLACE'd AGAIN from the LATEST body (migration 070, which
-- also clears snoozed_until). Copying an older version would silently
-- un-fix un-snooze; verify-schema.sql asserts both markers survive.
CREATE OR REPLACE FUNCTION public.bump_conversation_on_inbound(
  p_conversation_id UUID,
  p_last_message_text TEXT
)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE conversations
  SET unread_count              = COALESCE(unread_count, 0) + 1,
      last_message_text         = p_last_message_text,
      last_message_at           = NOW(),
      last_message_sender_type  = 'customer',
      last_customer_message_at  = NOW(),
      snoozed_until             = NULL,
      updated_at                = NOW()
  WHERE id = p_conversation_id;

  -- A customer replying is the strongest stop condition there is.
  SELECT public.cancel_followups(p_conversation_id, 'replied');
$$;
