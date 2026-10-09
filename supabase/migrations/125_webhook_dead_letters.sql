-- ============================================================
-- 125: inbound webhook payloads that could not be stored
-- (specs/review-2026-10.md, M4).
--
-- The webhook answers Meta 200 before processing (it must, or Meta
-- retries and times out), so a transient database error while saving a
-- message used to lose it for good: Meta never resends, and only a
-- console line remained. The webhook now retries in place (processing is
-- idempotent on the message id) and, if it still fails, keeps the raw
-- payload here so it can be replayed. Server-only: no RLS policies.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.webhook_dead_letters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text NOT NULL CHECK (source IN ('meta', 'waha')),
  payload jsonb NOT NULL,
  error text,
  attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  replayed_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_webhook_dead_letters_open
  ON public.webhook_dead_letters (created_at) WHERE replayed_at IS NULL;
ALTER TABLE public.webhook_dead_letters ENABLE ROW LEVEL SECURITY;
