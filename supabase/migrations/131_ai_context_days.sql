-- ============================================================
-- 131: how far back an agent's auto-reply looks (lib/ai/context.ts,
-- currentSession). NULL = the whole recent window, exactly as before —
-- every existing agent keeps that. A number of days N leaves out what
-- came before a silence longer than N days, so a customer coming back
-- with a new matter starts fresh (a barbershop visit, a store order),
-- while long processes (a loan in bank review, a property search) keep
-- NULL or a long window.
-- ============================================================

ALTER TABLE public.ai_configs
  ADD COLUMN IF NOT EXISTS context_days integer
    CHECK (context_days IS NULL OR (context_days BETWEEN 1 AND 365));
