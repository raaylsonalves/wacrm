/**
 * Internal notes live in their own table (migration 070) but the agent
 * reads them in the thread, at the moment they were written — like a
 * sticky note between two messages. This places each note before the
 * first message that came after it; notes newer than every message go
 * at the end.
 */
export const NOTES_CHANGED_EVENT = 'conversation-notes:changed';

interface Stamped {
  created_at: string;
}

export function placeNotes<N extends Stamped>(
  messages: (Stamped & { id: string })[],
  notes: N[]
): { before: Map<string, N[]>; after: N[] } {
  const before = new Map<string, N[]>();
  const after: N[] = [];
  const sorted = [...notes].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  let i = 0;
  for (const note of sorted) {
    const at = Date.parse(note.created_at);
    while (i < messages.length && Date.parse(messages[i].created_at) <= at) i++;
    if (i >= messages.length) {
      after.push(note);
      continue;
    }
    const id = messages[i].id;
    before.set(id, [...(before.get(id) ?? []), note]);
  }
  return { before, after };
}
