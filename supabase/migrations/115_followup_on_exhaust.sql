-- ============================================================
-- 115: what happens when a follow-up sequence ends unanswered
-- (specs/followup-sequences.md, "Ao terminar sem resposta").
--
-- A sequence that ran out of steps used to end in silence: the thread
-- stayed with the AI and nobody on the team knew the lead went cold.
-- The silence sweep now waits one more silence interval after the last
-- step and, if the customer still has not answered, runs the
-- automation's `on_exhaust` actions (notify the team, hand over to a
-- person, tag the contact, close). `exhaust_handled_at` is the claim, so
-- an overlapping sweep never runs them twice.
-- ============================================================

ALTER TABLE public.followup_enrollments
  ADD COLUMN IF NOT EXISTS exhaust_handled_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_followup_enrollments_exhaust_pending
  ON public.followup_enrollments (automation_id, ended_at)
  WHERE outcome = 'exhausted' AND exhaust_handled_at IS NULL;

ALTER TABLE public.notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE public.notifications
  ADD CONSTRAINT notifications_type_check
  CHECK (type IN (
    'conversation_assigned', 'customer_replied', 'handoff_waiting',
    'sla_breached', 'new_unassigned', 'case_opened', 'case_lead_replied',
    'case_relay_failed', 'appointment_reminder', 'deal_won', 'deal_lost',
    'deal_stage_changed', 'channel_disconnected', 'ai_provider_failed',
    'template_status', 'broadcast_finished', 'calendar_disconnected',
    'followup_no_reply'
  ));

INSERT INTO public.notification_types (type, category, in_app_default, push_default, position)
VALUES ('followup_no_reply', 'conversations', true, true, 55)
ON CONFLICT (type) DO NOTHING;
