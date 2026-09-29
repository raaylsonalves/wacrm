-- ============================================================
-- 081_contact_imports.sql — server-side CSV import with a per-row report
-- and a consent basis per contact (specs/prospecting-csv-import.md, part A).
--
--   contact_imports       — one row per import: name, how the contacts
--                           were obtained, update policy, counts.
--   contact_import_errors — each skipped line with a reason code. `raw`
--                           holds the offending cells (personal data):
--                           account-scoped, deleted with the import.
--   contacts.import_id / consent_basis — where a contact came from and
--                           whether it may be messaged. NULL (every
--                           contact before this) behaves exactly as
--                           before: no retroactive restriction.
--
-- Additive and idempotent.
-- ============================================================

CREATE TABLE IF NOT EXISTS contact_imports (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name            text NOT NULL,
  file_name       text,
  consent_basis   text NOT NULL CHECK (consent_basis IN
                    ('opt_in','existing_customer','legitimate_interest',
                     'third_party_list','unknown')),
  legal_basis_ref text,
  update_policy   text NOT NULL DEFAULT 'fill_empty'
                    CHECK (update_policy IN ('skip','fill_empty','overwrite')),
  status          text NOT NULL DEFAULT 'processing'
                    CHECK (status IN ('processing','completed','failed')),
  rows_total      integer NOT NULL DEFAULT 0,
  rows_created    integer NOT NULL DEFAULT 0,
  rows_updated    integer NOT NULL DEFAULT 0,
  rows_skipped    integer NOT NULL DEFAULT 0,
  created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_contact_imports_account
  ON contact_imports (account_id, created_at DESC);

CREATE TABLE IF NOT EXISTS contact_import_errors (
  import_id uuid NOT NULL REFERENCES contact_imports(id) ON DELETE CASCADE,
  line      integer NOT NULL,
  reason    text NOT NULL,
  raw       text,
  PRIMARY KEY (import_id, line)
);

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS import_id uuid
    REFERENCES contact_imports(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS consent_basis text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'contacts_consent_basis_check'
  ) THEN
    ALTER TABLE contacts
      ADD CONSTRAINT contacts_consent_basis_check
      CHECK (consent_basis IS NULL OR consent_basis IN
        ('opt_in','existing_customer','legitimate_interest',
         'third_party_list','unknown'));
  END IF;
END
$$;

ALTER TABLE contact_imports ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS contact_imports_select ON contact_imports;
CREATE POLICY contact_imports_select ON contact_imports
  FOR SELECT USING (is_account_member(account_id));
DROP POLICY IF EXISTS contact_imports_write ON contact_imports;
CREATE POLICY contact_imports_write ON contact_imports
  FOR ALL USING (is_account_member(account_id, 'agent'))
  WITH CHECK (is_account_member(account_id, 'agent'));

ALTER TABLE contact_import_errors ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS contact_import_errors_select ON contact_import_errors;
CREATE POLICY contact_import_errors_select ON contact_import_errors
  FOR SELECT USING (EXISTS (
    SELECT 1 FROM contact_imports i
    WHERE i.id = contact_import_errors.import_id
      AND is_account_member(i.account_id)));
DROP POLICY IF EXISTS contact_import_errors_write ON contact_import_errors;
CREATE POLICY contact_import_errors_write ON contact_import_errors
  FOR ALL USING (EXISTS (
    SELECT 1 FROM contact_imports i
    WHERE i.id = contact_import_errors.import_id
      AND is_account_member(i.account_id, 'agent')))
  WITH CHECK (EXISTS (
    SELECT 1 FROM contact_imports i
    WHERE i.id = contact_import_errors.import_id
      AND is_account_member(i.account_id, 'agent')));
