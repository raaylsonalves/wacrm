-- ============================================================
-- 053_contact_opt_out.sql — contact-level opt-out flag.
--
-- `opted_out_at` is set once, when the webhook detects a STOP-style
-- reply (see `lib/contacts/opt-out.ts`), and never cleared
-- automatically — re-subscribing is a deliberate action (Settings ›
-- Contact), not a side effect of the contact texting in again.
--
-- Partial index only covers the non-null case: broadcasts and the
-- automations engine both query "is this contact opted out", never
-- "list everyone who isn't", so a full index would just be dead
-- weight on every insert.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS opted_out_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_contacts_opted_out_at
  ON contacts (account_id)
  WHERE opted_out_at IS NOT NULL;
