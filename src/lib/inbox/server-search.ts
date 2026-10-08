// Server-side inbox search. The list only holds the pages scrolled so far
// (infinite scroll), so a search also asks the database for matching
// conversations and merges them in; the on-screen filter then shows them.

/** Shortest query worth a round trip. */
export const MIN_SERVER_SEARCH = 2;

/**
 * The query as a safe PostgREST `ilike` pattern body, or null when too
 * short. Characters that carry meaning in a PostgREST `or=(...)` filter
 * (comma, parentheses, quotes, backslash) and the LIKE wildcards are
 * dropped rather than escaped: a search box never needs them, and a
 * stray one must not break the filter or widen the match.
 */
export function serverSearchTerm(raw: string): string | null {
  const term = raw
    .replace(/[,()"'\\%*_:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return term.length >= MIN_SERVER_SEARCH ? term : null;
}
