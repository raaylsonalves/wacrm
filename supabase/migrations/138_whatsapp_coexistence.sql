-- ============================================================
-- 138: WhatsApp Business app coexistence (specs/whatsapp-coexistence.md)
--
-- A customer connects the number they already use in the WhatsApp
-- Business app through Meta's hosted Embedded Signup link. Meta reports
-- the result by webhook (account_update PARTNER_ADDED), which carries no
-- state of ours, so the CRM first records who asked to connect which
-- number (whatsapp_signups) and matches the webhook to it by number.
--
--   whatsapp_config.onboarding_mode   'api' (number only on the API, as
--                                     before) or 'coexistence' (also
--                                     live in the app on the phone)
--   whatsapp_config.coexistence_sync  request ids of the one-shot
--                                     contacts / history syncs
--   messages.sent_from                'business_app' = the owner sent it
--                                     from the phone (an echo)
--   conversations.ai_handoff_reason   + 'phone_reply': the AI paused
--                                     because a person answered from
--                                     the phone
-- ============================================================

ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS onboarding_mode text NOT NULL DEFAULT 'api',
  ADD COLUMN IF NOT EXISTS coexistence_sync jsonb,
  ADD COLUMN IF NOT EXISTS coexistence_synced_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'whatsapp_config_onboarding_mode_check') THEN
    ALTER TABLE whatsapp_config
      ADD CONSTRAINT whatsapp_config_onboarding_mode_check
      CHECK (onboarding_mode IN ('api', 'coexistence'));
  END IF;
END $$;

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS sent_from text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'messages_sent_from_check') THEN
    ALTER TABLE messages
      ADD CONSTRAINT messages_sent_from_check
      CHECK (sent_from IS NULL OR sent_from IN ('business_app'));
  END IF;
END $$;

ALTER TABLE conversations
  DROP CONSTRAINT IF EXISTS conversations_ai_handoff_reason_check;
ALTER TABLE conversations
  ADD CONSTRAINT conversations_ai_handoff_reason_check
  CHECK (ai_handoff_reason IS NULL OR ai_handoff_reason IN (
    'model_requested', 'reply_cap', 'provider_failure',
    'empty_reply', 'rate_limited', 'system_error',
    'customer_requested_human', 'audio_unintelligible',
    'case_escalated', 'flow_handoff', 'followup_exhausted',
    'automated_sender', 'phone_reply'
  ));

-- One row per "connect my WhatsApp" attempt. `waiting` until Meta's
-- webhook names the number; `unmatched` when a webhook arrived that no
-- waiting row claims (account_id NULL: the platform sorts it out).
CREATE TABLE IF NOT EXISTS whatsapp_signups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid REFERENCES accounts(id) ON DELETE CASCADE,
  requested_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  -- Digits only, as the customer typed it (with country code).
  phone_digits text,
  mode text NOT NULL DEFAULT 'coexistence' CHECK (mode IN ('api', 'coexistence')),
  status text NOT NULL DEFAULT 'waiting'
    CHECK (status IN ('waiting', 'connected', 'unmatched', 'failed')),
  waba_id text,
  owner_business_id text,
  phone_number_id text,
  display_phone_number text,
  whatsapp_config_id uuid REFERENCES whatsapp_config(id) ON DELETE SET NULL,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS whatsapp_signups_waiting_idx
  ON whatsapp_signups (phone_digits) WHERE status = 'waiting';
CREATE INDEX IF NOT EXISTS whatsapp_signups_account_idx
  ON whatsapp_signups (account_id, created_at DESC);

DROP TRIGGER IF EXISTS set_updated_at ON whatsapp_signups;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON whatsapp_signups
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Members read their own account's attempts (the settings card polls
-- them). Writes go through the API route and the webhook (service role).
ALTER TABLE whatsapp_signups ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS whatsapp_signups_select ON whatsapp_signups;
CREATE POLICY whatsapp_signups_select ON whatsapp_signups FOR SELECT
  USING (account_id IS NOT NULL AND is_account_member(account_id));
