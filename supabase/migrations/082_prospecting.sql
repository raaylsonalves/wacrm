-- ============================================================
-- 082_prospecting.sql — prospecting campaigns (specs/prospecting-csv-import.md,
-- part B). Two first-touch paths that share everything else:
--   - WAHA:  the campaign's AI agent writes a personalised approach;
--   - Cloud: an APPROVED template (a first business-initiated message on
--            the official API needs one), with contact data as variables.
--
-- The funnel is counted from STAMPS (sent_at, replied_at, qualified_at),
-- never from status — status is one value and "sent" would fall as the
-- campaign went well. The three stamps a campaign can't see from its own
-- code path (a reply, a deal moved by hand, an opt-out) are set by
-- triggers, so they work the same on both channels.
--
-- conversations.pinned_ai_agent_id: the agent that must answer this
-- conversation (the campaign's), ahead of the router and the per-number
-- binding — so the reply to an approach is answered by whoever wrote it.
--
-- Idempotent.
-- ============================================================

CREATE TABLE IF NOT EXISTS prospecting_campaigns (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name         text NOT NULL,
  import_id    uuid REFERENCES contact_imports(id) ON DELETE SET NULL,
  status       text NOT NULL DEFAULT 'draft'
                 CHECK (status IN ('draft','running','paused','completed','cancelled')),
  config       jsonb NOT NULL,
  next_send_at timestamptz NOT NULL DEFAULT now(),
  error        text,
  created_by   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_prospecting_campaigns_account
  ON prospecting_campaigns (account_id, created_at DESC);
-- One running campaign per account: the pacing is per account.
CREATE UNIQUE INDEX IF NOT EXISTS prospecting_one_running_per_account
  ON prospecting_campaigns (account_id) WHERE status = 'running';

CREATE TABLE IF NOT EXISTS prospecting_candidates (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id     uuid NOT NULL REFERENCES prospecting_campaigns(id) ON DELETE CASCADE,
  account_id      uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id      uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  deal_id         uuid REFERENCES deals(id) ON DELETE SET NULL,
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  status          text NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued','sending','sent','failed','skipped')),
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  attempted_at    timestamptz,
  sent_at         timestamptz,
  replied_at      timestamptz,
  qualified_at    timestamptz,
  opted_out_at    timestamptz,
  UNIQUE (campaign_id, contact_id)
);
CREATE INDEX IF NOT EXISTS idx_prospecting_candidates_queue
  ON prospecting_candidates (campaign_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_prospecting_candidates_conversation
  ON prospecting_candidates (conversation_id);
CREATE INDEX IF NOT EXISTS idx_prospecting_candidates_deal
  ON prospecting_candidates (deal_id);

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS pinned_ai_agent_id uuid
    REFERENCES ai_configs(id) ON DELETE SET NULL;

-- ---- Claim the next candidate atomically --------------------------
CREATE OR REPLACE FUNCTION public.claim_prospecting_candidate(p_campaign_id uuid)
RETURNS SETOF prospecting_candidates
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE prospecting_candidates c
     SET status = 'sending', attempted_at = now()
   WHERE c.id = (
     SELECT id FROM prospecting_candidates
      WHERE campaign_id = p_campaign_id AND status = 'queued'
      ORDER BY created_at, id
      LIMIT 1
      FOR UPDATE SKIP LOCKED)
  RETURNING c.*;
$$;
REVOKE ALL ON FUNCTION public.claim_prospecting_candidate(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_prospecting_candidate(uuid) TO service_role;

-- ---- Stamp: the customer replied (within 72h of the approach) -----
CREATE OR REPLACE FUNCTION public.prospecting_stamp_reply()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.sender_type = 'customer' THEN
    UPDATE prospecting_candidates
       SET replied_at = now()
     WHERE conversation_id = NEW.conversation_id
       AND replied_at IS NULL
       AND sent_at IS NOT NULL
       AND sent_at > now() - interval '72 hours';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS trg_prospecting_stamp_reply ON messages;
CREATE TRIGGER trg_prospecting_stamp_reply
  AFTER INSERT ON messages
  FOR EACH ROW EXECUTE FUNCTION public.prospecting_stamp_reply();

-- ---- Stamp: the deal reached the campaign's qualified stage ------
-- By the AI tool or by a person dragging the card — both count.
CREATE OR REPLACE FUNCTION public.prospecting_stamp_qualified()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.stage_id IS DISTINCT FROM OLD.stage_id THEN
    UPDATE prospecting_candidates c
       SET qualified_at = now()
      FROM prospecting_campaigns p
     WHERE c.deal_id = NEW.id
       AND c.qualified_at IS NULL
       AND p.id = c.campaign_id
       AND p.config->>'qualified_stage_id' = NEW.stage_id::text;
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS trg_prospecting_stamp_qualified ON deals;
CREATE TRIGGER trg_prospecting_stamp_qualified
  AFTER UPDATE OF stage_id ON deals
  FOR EACH ROW EXECUTE FUNCTION public.prospecting_stamp_qualified();

-- ---- Stamp: the contact opted out --------------------------------
CREATE OR REPLACE FUNCTION public.prospecting_stamp_opt_out()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.opted_out_at IS NOT NULL AND OLD.opted_out_at IS NULL THEN
    UPDATE prospecting_candidates
       SET status = 'skipped', error = 'opted_out'
     WHERE contact_id = NEW.id AND status = 'queued';
    UPDATE prospecting_candidates
       SET opted_out_at = now()
     WHERE contact_id = NEW.id AND sent_at IS NOT NULL AND opted_out_at IS NULL;
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS trg_prospecting_stamp_opt_out ON contacts;
CREATE TRIGGER trg_prospecting_stamp_opt_out
  AFTER UPDATE OF opted_out_at ON contacts
  FOR EACH ROW EXECUTE FUNCTION public.prospecting_stamp_opt_out();

-- ---- RLS: members read; writes go through the API (service role) ---
ALTER TABLE prospecting_campaigns ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS prospecting_campaigns_select ON prospecting_campaigns;
CREATE POLICY prospecting_campaigns_select ON prospecting_campaigns
  FOR SELECT USING (is_account_member(account_id));

ALTER TABLE prospecting_candidates ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS prospecting_candidates_select ON prospecting_candidates;
CREATE POLICY prospecting_candidates_select ON prospecting_candidates
  FOR SELECT USING (is_account_member(account_id));
