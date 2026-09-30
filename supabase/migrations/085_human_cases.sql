-- ============================================================
-- 085_human_cases.sql — the AI keeps the customer, a teammate does the
-- task (specs/human-cases.md).
--
--   human_cases        — one delegated task per row; status is a small
--                        state machine enforced in src/lib/cases (the
--                        CHECK guards the vocabulary, the code the order).
--   human_case_events  — every transition, who did it and the note.
--   ai_configs.cases_enabled — per-agent opt-in for the case tools.
--   conversations.ai_handoff_reason gains 'case_escalated'.
--   notifications.type gains the case notifications.
--   Opt-out or a closed conversation cancels open cases (triggers).
--
-- RLS: members read; NO client write policy — every transition goes
-- through the API under the service role, so the state machine can't be
-- bypassed by a browser update.
--
-- Idempotent.
-- ============================================================

CREATE TABLE IF NOT EXISTS human_cases (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  contact_id      uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  title           text NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  summary         text NOT NULL CHECK (length(summary) <= 1000),
  blocker         text NOT NULL CHECK (length(blocker) <= 500),
  -- The last messages when the case opened, read from the DB by the
  -- runtime (never from model arguments).
  excerpt         text,
  status          text NOT NULL DEFAULT 'awaiting_human' CHECK (status IN
                    ('awaiting_human','awaiting_lead','resolved','escalated','cancelled')),
  opened_by       text NOT NULL DEFAULT 'ai' CHECK (opened_by IN ('ai','system','human')),
  claimed_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  -- The note the AI must relay, and whether it managed to.
  pending_note    text,
  pending_action  text CHECK (pending_action IS NULL OR pending_action IN ('done','need_info')),
  relay_status    text CHECK (relay_status IS NULL OR relay_status IN
                    ('pending','sent','window_closed','failed')),
  opened_at       timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  resolved_at     timestamptz
);
CREATE INDEX IF NOT EXISTS idx_human_cases_open
  ON human_cases (account_id, status)
  WHERE status IN ('awaiting_human','awaiting_lead');
CREATE INDEX IF NOT EXISTS idx_human_cases_conversation
  ON human_cases (conversation_id, status);
CREATE INDEX IF NOT EXISTS idx_human_cases_relay
  ON human_cases (relay_status) WHERE relay_status = 'pending';

CREATE TABLE IF NOT EXISTS human_case_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id       uuid NOT NULL REFERENCES human_cases(id) ON DELETE CASCADE,
  account_id    uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind          text NOT NULL,
  actor_kind    text NOT NULL CHECK (actor_kind IN ('ai','human','system')),
  actor_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  body          text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_human_case_events_case
  ON human_case_events (case_id, created_at);

ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS cases_enabled boolean NOT NULL DEFAULT false;

ALTER TABLE conversations
  DROP CONSTRAINT IF EXISTS conversations_ai_handoff_reason_check;
ALTER TABLE conversations
  ADD CONSTRAINT conversations_ai_handoff_reason_check
  CHECK (ai_handoff_reason IS NULL OR ai_handoff_reason IN (
    'model_requested', 'reply_cap', 'provider_failure',
    'empty_reply', 'rate_limited', 'system_error',
    'customer_requested_human', 'audio_unintelligible', 'case_escalated'
  ));

ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications
  ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('conversation_assigned', 'case_opened', 'case_lead_replied', 'case_relay_failed'));

-- ---- Cancel open cases when the conversation closes or the contact opts out
CREATE OR REPLACE FUNCTION public.cancel_open_cases()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  reason text;
BEGIN
  IF TG_TABLE_NAME = 'conversations' THEN
    IF NEW.status = 'closed' AND OLD.status IS DISTINCT FROM 'closed' THEN
      reason := 'conversation_closed';
      WITH c AS (
        UPDATE human_cases SET status = 'cancelled', updated_at = now(), resolved_at = now()
         WHERE conversation_id = NEW.id AND status IN ('awaiting_human','awaiting_lead')
        RETURNING id, account_id)
      INSERT INTO human_case_events (case_id, account_id, kind, actor_kind, body)
      SELECT id, account_id, 'cancelled', 'system', reason FROM c;
    END IF;
  ELSE
    IF NEW.opted_out_at IS NOT NULL AND OLD.opted_out_at IS NULL THEN
      reason := 'opted_out';
      WITH c AS (
        UPDATE human_cases SET status = 'cancelled', updated_at = now(), resolved_at = now()
         WHERE contact_id = NEW.id AND status IN ('awaiting_human','awaiting_lead')
        RETURNING id, account_id)
      INSERT INTO human_case_events (case_id, account_id, kind, actor_kind, body)
      SELECT id, account_id, 'cancelled', 'system', reason FROM c;
    END IF;
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS trg_cases_cancel_on_close ON conversations;
CREATE TRIGGER trg_cases_cancel_on_close
  AFTER UPDATE OF status ON conversations
  FOR EACH ROW EXECUTE FUNCTION public.cancel_open_cases();
DROP TRIGGER IF EXISTS trg_cases_cancel_on_opt_out ON contacts;
CREATE TRIGGER trg_cases_cancel_on_opt_out
  AFTER UPDATE OF opted_out_at ON contacts
  FOR EACH ROW EXECUTE FUNCTION public.cancel_open_cases();

ALTER TABLE human_cases ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS human_cases_select ON human_cases;
CREATE POLICY human_cases_select ON human_cases
  FOR SELECT USING (is_account_member(account_id));

ALTER TABLE human_case_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS human_case_events_select ON human_case_events;
CREATE POLICY human_case_events_select ON human_case_events
  FOR SELECT USING (is_account_member(account_id));
