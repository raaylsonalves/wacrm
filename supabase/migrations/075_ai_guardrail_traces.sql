-- ============================================================
-- 075_ai_guardrail_traces.sql — one row per AI reply that a
-- before-send gate WOULD have blocked (specs/ai-output-guardrails.md).
--
-- Observe mode first: the chain runs on every AI reply and records what
-- it would have vetoed, but sends the reply anyway. A week of these rows
-- shows the false-positive rate before anything is enforced.
--
-- Written only by the server (service role); members can read.
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS ai_guardrail_traces (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  conversation_id uuid REFERENCES conversations(id) ON DELETE CASCADE,
  chain_version   integer NOT NULL,
  gate            text NOT NULL,
  code            text NOT NULL,
  -- 'observe' = recorded only; 'enforce' = the reply was blocked.
  mode            text NOT NULL DEFAULT 'observe'
                  CHECK (mode IN ('observe', 'enforce')),
  -- What the model wrote, clipped — so a human can judge the verdict.
  reply_excerpt   text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_guardrail_traces_account
  ON ai_guardrail_traces (account_id, created_at DESC);

ALTER TABLE ai_guardrail_traces ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_guardrail_traces_select ON ai_guardrail_traces;
CREATE POLICY ai_guardrail_traces_select ON ai_guardrail_traces
  FOR SELECT USING (is_account_member(account_id));
-- No INSERT/UPDATE/DELETE policy: only the service role writes.
