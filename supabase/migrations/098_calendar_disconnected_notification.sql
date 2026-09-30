-- 098_calendar_disconnected_notification.sql
--
-- A notification for the account's admins when Google Calendar stops
-- accepting the stored authorization (revoked, expired, password change).
-- The sync pauses without deleting anything; someone has to reconnect.
-- Written by the cron worker (src/lib/google-calendar/sync.ts).

ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications
  ADD CONSTRAINT notifications_type_check
  CHECK (type IN (
    'conversation_assigned', 'customer_replied', 'handoff_waiting',
    'sla_breached', 'new_unassigned', 'case_opened', 'case_lead_replied',
    'case_relay_failed', 'appointment_reminder', 'deal_won', 'deal_lost',
    'deal_stage_changed', 'channel_disconnected', 'ai_provider_failed',
    'template_status', 'broadcast_finished', 'calendar_disconnected'
  ));

INSERT INTO notification_types (type, category, in_app_default, push_default, position)
VALUES ('calendar_disconnected', 'system', true, true, 215)
ON CONFLICT (type) DO NOTHING;
