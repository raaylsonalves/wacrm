-- 101_opt_out_confirmation.sql
--
-- The STOP confirmation ("you won't get more messages") used to ride the
-- AI's handoff notice, so it was never sent when the AI was off or already
-- paused on that conversation. It is now sent on its own, once per
-- opt-out: this column is the claim (set → already confirmed). Clearing an
-- opt-out ("Reativar" in the contact panel) clears it too, so a later STOP
-- is confirmed again.

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS opt_out_confirmed_at timestamptz;
