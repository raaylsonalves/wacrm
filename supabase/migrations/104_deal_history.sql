-- ============================================================
-- 104: deal history + realtime deals
--
-- Two things the deals board lacked:
--   1. A history per deal — who moved it, changed its value, owner,
--      status, title or close date, and when. Written by a trigger on
--      `deals`, so every writer (dashboard, /api/v1, automations,
--      MCP) is covered without touching any of them.
--   2. Realtime: `deals` joins the supabase_realtime publication so a
--      colleague's change shows on the board without a reload.
--
-- Additive only: one new table, one trigger, publication membership.
-- ============================================================

CREATE TABLE IF NOT EXISTS deal_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  deal_id UUID NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  -- auth.uid() of the person who made the change; NULL for the
  -- service-role writers (automations, webhook, API keys).
  actor_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN (
    'created', 'stage', 'value', 'owner', 'status', 'title', 'close_date'
  )),
  from_value JSONB,
  to_value JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_deal_events_deal
  ON deal_events(deal_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_deal_events_account
  ON deal_events(account_id);

ALTER TABLE deal_events ENABLE ROW LEVEL SECURITY;

-- Read-only to members; rows are only ever written by the trigger
-- below (SECURITY DEFINER), so there is no insert/update policy.
DROP POLICY IF EXISTS deal_events_select ON deal_events;
CREATE POLICY deal_events_select ON deal_events
  FOR SELECT USING (is_account_member(account_id));

CREATE OR REPLACE FUNCTION record_deal_events()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  actor UUID := auth.uid();
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO deal_events (account_id, deal_id, actor_user_id, kind, to_value)
    VALUES (NEW.account_id, NEW.id, actor, 'created',
            jsonb_build_object('stage_id', NEW.stage_id, 'value', NEW.value));
    RETURN NEW;
  END IF;

  IF NEW.stage_id IS DISTINCT FROM OLD.stage_id THEN
    INSERT INTO deal_events (account_id, deal_id, actor_user_id, kind, from_value, to_value)
    VALUES (NEW.account_id, NEW.id, actor, 'stage',
            to_jsonb(OLD.stage_id), to_jsonb(NEW.stage_id));
  END IF;
  IF NEW.value IS DISTINCT FROM OLD.value THEN
    INSERT INTO deal_events (account_id, deal_id, actor_user_id, kind, from_value, to_value)
    VALUES (NEW.account_id, NEW.id, actor, 'value',
            to_jsonb(OLD.value), to_jsonb(NEW.value));
  END IF;
  IF NEW.assigned_to IS DISTINCT FROM OLD.assigned_to THEN
    INSERT INTO deal_events (account_id, deal_id, actor_user_id, kind, from_value, to_value)
    VALUES (NEW.account_id, NEW.id, actor, 'owner',
            to_jsonb(OLD.assigned_to), to_jsonb(NEW.assigned_to));
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO deal_events (account_id, deal_id, actor_user_id, kind, from_value, to_value)
    VALUES (NEW.account_id, NEW.id, actor, 'status',
            to_jsonb(OLD.status), to_jsonb(NEW.status));
  END IF;
  IF NEW.title IS DISTINCT FROM OLD.title THEN
    INSERT INTO deal_events (account_id, deal_id, actor_user_id, kind, from_value, to_value)
    VALUES (NEW.account_id, NEW.id, actor, 'title',
            to_jsonb(OLD.title), to_jsonb(NEW.title));
  END IF;
  IF NEW.expected_close_date IS DISTINCT FROM OLD.expected_close_date THEN
    INSERT INTO deal_events (account_id, deal_id, actor_user_id, kind, from_value, to_value)
    VALUES (NEW.account_id, NEW.id, actor, 'close_date',
            to_jsonb(OLD.expected_close_date), to_jsonb(NEW.expected_close_date));
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS deals_record_events ON deals;
CREATE TRIGGER deals_record_events
  AFTER INSERT OR UPDATE ON deals
  FOR EACH ROW EXECUTE FUNCTION record_deal_events();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'deals'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE deals;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'deal_events'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE deal_events;
  END IF;
END $$;
