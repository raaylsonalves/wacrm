-- ============================================================
-- 072_ai_handoff_reason.sql — store WHY the AI handed off, not the
-- English sentence (specs/handoff-customer-notice.md).
--
-- Until now the auto-reply bot wrote a finished English sentence into
-- conversations.ai_handoff_summary. The app is build-time
-- single-locale, so that sentence could not be translated and the
-- banner could only truncate it. The reason + structured facts are
-- stored instead and rendered localized by the client.
--
-- Also records whether the customer was told a person is coming, so
-- whoever opens the thread knows if the customer is waiting in the
-- dark. ai_handoff_summary stays: rows written before this migration
-- keep rendering through it.
--
-- `text` + CHECK rather than an enum so a new reason is a one-line
-- migration (same convention as the broadcast/channel statuses).
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS ai_handoff_reason text,
  ADD COLUMN IF NOT EXISTS ai_handoff_meta jsonb,
  ADD COLUMN IF NOT EXISTS ai_handoff_customer_notified boolean,
  ADD COLUMN IF NOT EXISTS ai_handoff_notice_skipped_reason text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.conversations'::regclass
      AND conname = 'conversations_ai_handoff_reason_check'
  ) THEN
    ALTER TABLE conversations
      ADD CONSTRAINT conversations_ai_handoff_reason_check
      CHECK (ai_handoff_reason IS NULL OR ai_handoff_reason IN (
        'model_requested', 'reply_cap', 'provider_failure',
        'empty_reply', 'rate_limited', 'system_error',
        'customer_requested_human'
      ));
  END IF;
END
$$;
