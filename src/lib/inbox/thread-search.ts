/**
 * In-conversation search: which loaded messages contain the query.
 * Case- and accent-insensitive ("cotacao" finds "cotação"), oldest first,
 * over the text a person would have read — a voice note counts by its
 * transcript.
 */
export interface SearchableMessage {
  id: string;
  content_text?: string | null;
  transcript?: string | null;
}

export function normalizeForSearch(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

export function findMatches(
  messages: SearchableMessage[],
  query: string
): string[] {
  const q = normalizeForSearch(query.trim());
  if (q.length < 2) return [];
  return messages
    .filter((m) =>
      normalizeForSearch(
        `${m.content_text ?? ''} ${m.transcript ?? ''}`
      ).includes(q)
    )
    .map((m) => m.id);
}
