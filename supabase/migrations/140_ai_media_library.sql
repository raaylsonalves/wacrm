-- ============================================================
-- 140: pictures an AI agent may send (lib/ai/tools/media.ts).
-- [{ id, name, when, url }] — `when` tells the model in which situation
-- to send it (e.g. "the customer asks for prices"). The model decides from
-- the conversation, instead of a keyword automation that fired on any
-- "valor". Empty = the agent has no send_image tool, as before.
-- ============================================================

ALTER TABLE public.ai_configs
  ADD COLUMN IF NOT EXISTS media_library jsonb NOT NULL DEFAULT '[]'::jsonb;
