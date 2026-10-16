-- ============================================================
-- 135: the account's business segment (specs/painel-gestor.md, phase 3).
--
-- Onboarding already asked it (onboarding_state.profile.profile.segment,
-- lib/onboarding/profile SEGMENTS) but only fed the AI prompt. As a
-- column it drives the segment profile: what deals are called, the
-- default funnel stages, which dashboard blocks show, and the order of
-- loss reasons (lib/segments/profiles.ts). Admins edit it in Settings;
-- accounts_update RLS already allows that, and it isn't a billing
-- column, so the 129 guard leaves it alone.
-- ============================================================

ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS segment text
    CHECK (segment IN ('beauty', 'health', 'retail', 'services', 'education', 'finance', 'realestate', 'other'));

UPDATE public.accounts
   SET segment = onboarding_state #>> '{profile,profile,segment}'
 WHERE segment IS NULL
   AND onboarding_state #>> '{profile,profile,segment}' IN
       ('beauty', 'health', 'retail', 'services', 'education', 'finance', 'realestate', 'other');
