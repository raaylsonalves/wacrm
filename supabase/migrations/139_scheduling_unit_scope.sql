-- ============================================================
-- 139: limit a scheduling integration to some of the partner's units.
-- One ScaLE key can cover several shops (Mr. Jack Aldeota + Sul) while a
-- CRM account serves only one of them. NULL = every unit the key sees,
-- exactly as before. Applied in lib/scheduling/integration.ts
-- (restrictUnits): the AI never lists, searches or books outside them.
-- ============================================================

ALTER TABLE public.scheduling_integrations
  ADD COLUMN IF NOT EXISTS unit_ids text[];

GRANT SELECT (unit_ids) ON public.scheduling_integrations TO authenticated;
