-- ============================================================
-- 141: remind the customer of a partner-system booking (ScaLE) a while
-- before it starts (lib/scheduling/reminders.ts, from the automations
-- cron). Off unless reminder_minutes AND reminder_text are set.
--
-- reminder_text placeholders: {nome} {data} {hora} {barbeiro} {codigo}.
-- timezone: the shop's zone — the partner's times are local wall time.
-- external_bookings.reminded_at: sent once, never twice.
-- ============================================================

ALTER TABLE public.scheduling_integrations
  ADD COLUMN IF NOT EXISTS reminder_minutes integer
    CHECK (reminder_minutes IS NULL OR reminder_minutes BETWEEN 10 AND 2880),
  ADD COLUMN IF NOT EXISTS reminder_text text,
  ADD COLUMN IF NOT EXISTS timezone text NOT NULL DEFAULT 'America/Sao_Paulo';

GRANT SELECT (reminder_minutes, reminder_text, timezone)
  ON public.scheduling_integrations TO authenticated;

ALTER TABLE public.external_bookings
  ADD COLUMN IF NOT EXISTS reminded_at timestamptz;
