-- 095_message_stars.sql
--
-- Starred messages: a personal bookmark on a message ("guardar esse
-- endereço", "esse preço que o cliente confirmou"). Per user, like
-- WhatsApp's own stars — a teammate never sees yours. conversation_id is
-- carried on the row so a thread loads its stars with one query.

CREATE TABLE IF NOT EXISTS message_stars (
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  message_id      uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  account_id      uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, message_id)
);

CREATE INDEX IF NOT EXISTS idx_message_stars_conversation
  ON message_stars (user_id, conversation_id);

ALTER TABLE message_stars ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS message_stars_select ON message_stars;
CREATE POLICY message_stars_select ON message_stars FOR SELECT
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS message_stars_insert ON message_stars;
CREATE POLICY message_stars_insert ON message_stars FOR INSERT
  WITH CHECK (user_id = auth.uid() AND is_account_member(account_id, 'viewer'));

DROP POLICY IF EXISTS message_stars_delete ON message_stars;
CREATE POLICY message_stars_delete ON message_stars FOR DELETE
  USING (user_id = auth.uid());
