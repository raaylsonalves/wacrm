-- ============================================================
-- 054_contact_anonymization.sql — LGPD "right to be forgotten" flag.
--
-- `anonymized_at` marks a contact whose PII has been scrubbed by
-- `POST /api/contacts/[id]/anonymize` (name, phone, email, company,
-- avatar, WhatsApp identity fields — see lib/contacts/anonymize.ts).
-- Anonymization is preferred over delete: conversations, messages and
-- deals stay in place (timestamps and structure preserved for the
-- business's own records), only the identifying fields are wiped and
-- any message media is removed from Storage.
--
-- Never cleared automatically — same rationale as opted_out_at
-- (migration 053): undoing an anonymization is a deliberate action,
-- not a side effect.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS anonymized_at TIMESTAMPTZ;
