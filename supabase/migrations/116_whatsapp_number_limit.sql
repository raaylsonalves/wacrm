-- ============================================================
-- 116: how many WhatsApp numbers an account may connect
-- (specs/multi-official-numbers.md, stage 3).
--
-- The standard plans (Essencial, Profissional, Escala) include ONE
-- WhatsApp number — official (Meta) or own (QR / WAHA). More numbers are
-- a custom ("sob medida") deal, set per account by the platform in the
-- Subscribers panel. NULL = the default for the account's status:
-- exempt accounts (the platform, clients the operator manages) are
-- unlimited, every other account gets 1 (lib/billing/number-limit.ts).
-- ============================================================

ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS max_whatsapp_numbers integer
    CHECK (max_whatsapp_numbers IS NULL OR max_whatsapp_numbers >= 1);
