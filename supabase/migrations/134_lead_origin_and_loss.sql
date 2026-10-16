-- ============================================================
-- 134: where leads come from, and why deals are lost
-- (specs/painel-gestor.md, phase 2).
--
--   * contacts.lead_source / lead_source_detail / lead_source_at — the
--     first touch. Set by the webhook: 'ad' when Meta sends a
--     click-to-WhatsApp referral, 'link' when the first message carries
--     a tracking-link code (#code), 'organic' otherwise. NULL = created
--     another way (manual, import, API) before anyone said.
--   * tracking_links — wa.me links with a prefilled "#code" so a
--     business can tell Instagram bio from flyer from Google.
--   * deals.lost_reason / lost_note — asked when a deal is marked lost.
--   * lead_origin_report / loss_report — the manager's two tables.
-- ============================================================

ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS lead_source text
    CHECK (lead_source IN ('ad', 'link', 'organic', 'manual', 'import', 'api')),
  ADD COLUMN IF NOT EXISTS lead_source_detail jsonb,
  ADD COLUMN IF NOT EXISTS lead_source_at timestamptz;

ALTER TABLE public.deals
  ADD COLUMN IF NOT EXISTS lost_reason text
    CHECK (lost_reason IN ('price', 'timing', 'competitor', 'no_response', 'not_fit', 'other')),
  ADD COLUMN IF NOT EXISTS lost_note text CHECK (char_length(lost_note) <= 1000);

CREATE TABLE IF NOT EXISTS public.tracking_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  code text NOT NULL CHECK (code ~ '^[a-z0-9_-]{2,30}$'),
  label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 80),
  message text NOT NULL DEFAULT '' CHECK (char_length(message) <= 300),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, code)
);

ALTER TABLE public.tracking_links ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tracking_links_select ON public.tracking_links;
CREATE POLICY tracking_links_select ON public.tracking_links FOR SELECT
  USING (is_account_member(account_id, 'viewer'));
DROP POLICY IF EXISTS tracking_links_insert ON public.tracking_links;
CREATE POLICY tracking_links_insert ON public.tracking_links FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS tracking_links_update ON public.tracking_links;
CREATE POLICY tracking_links_update ON public.tracking_links FOR UPDATE
  USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS tracking_links_delete ON public.tracking_links;
CREATE POLICY tracking_links_delete ON public.tracking_links FOR DELETE
  USING (is_account_member(account_id, 'admin'));

-- Leads that arrived in the period, by origin, and what they turned into.
CREATE OR REPLACE FUNCTION public.lead_origin_report(
  p_account_id uuid, p_from timestamptz, p_to timestamptz
)
RETURNS TABLE (source text, label text, leads bigint, deals_won bigint, won_value numeric)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public
AS $$
  WITH c AS (
    SELECT id,
           coalesce(lead_source, 'unknown') AS source,
           coalesce(lead_source_detail->>'label', lead_source_detail->>'headline',
                    lead_source_detail->>'source_id', '') AS label
      FROM contacts
     WHERE account_id = p_account_id
       AND created_at >= p_from AND created_at < p_to
  )
  SELECT c.source, c.label,
         count(DISTINCT c.id),
         count(DISTINCT d.id) FILTER (WHERE d.status = 'won'),
         coalesce(sum(d.value) FILTER (WHERE d.status = 'won'), 0)
    FROM c
    LEFT JOIN deals d ON d.contact_id = c.id AND d.account_id = p_account_id
   GROUP BY c.source, c.label
   ORDER BY 3 DESC
$$;

-- Deals marked lost in the period, by reason.
CREATE OR REPLACE FUNCTION public.loss_report(
  p_account_id uuid, p_from timestamptz, p_to timestamptz
)
RETURNS TABLE (reason text, deals bigint, lost_value numeric)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public
AS $$
  SELECT coalesce(d.lost_reason, 'unknown'), count(*), coalesce(sum(d.value), 0)
    FROM deals d
   WHERE d.account_id = p_account_id
     AND d.status = 'lost'
     AND EXISTS (
       SELECT 1 FROM deal_events e
        WHERE e.deal_id = d.id AND e.kind = 'status'
          AND e.to_value = '"lost"'::jsonb
          AND e.created_at >= p_from AND e.created_at < p_to
     )
   GROUP BY 1
   ORDER BY 2 DESC
$$;
