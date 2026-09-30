-- 094_conversation_summary.sql
--
-- "Resumo e próximo passo": an AI-written summary of a conversation plus a
-- suggested next action, shown in the contact panel. Generated on demand
-- (a button), never automatically — it costs tokens on the account's own
-- key. The last result is kept on the conversation so reopening it is free.
--
--   ai_summary    { "summary": text, "next_step": text }
--   ai_summary_at when it was generated (the card shows how old it is)

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS ai_summary jsonb;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS ai_summary_at timestamptz;
