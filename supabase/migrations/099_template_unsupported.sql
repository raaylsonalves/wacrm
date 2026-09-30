-- 099_template_unsupported.sql
--
-- Templates Meta approved but this CRM cannot send yet (carousel, limited-
-- time offer, catalog / multi-product, location header). The sync writes
-- the reason; the broadcast and inbox pickers show them disabled instead
-- of letting a send fail at Meta with #132012. NULL = sendable.

ALTER TABLE message_templates ADD COLUMN IF NOT EXISTS unsupported_reason text;
