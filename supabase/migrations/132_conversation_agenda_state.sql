-- ============================================================
-- 132: what the AI has already settled in a booking conversation —
-- location, service(s), day — when the agenda lives in a partner system
-- (migration 130, lib/ai/tools/scale.ts).
--
-- The transcript the model sees is chat text only; tool results do not
-- survive to the next turn. Seen live: the model re-listed locations and
-- services every message (20–25 s replies, ~10k prompt tokens) and once
-- answered about the wrong location. The tools write the settled choices
-- here and auto-reply hands them back in the prompt.
--
-- Shape: { unit_id, unit_name, service_ids[], service_names[], date,
--          updated_at }. Server-written only (service role).
-- ============================================================

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS ai_agenda_state jsonb;
