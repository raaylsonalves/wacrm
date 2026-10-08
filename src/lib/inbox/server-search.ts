// Server-side inbox search. The list only holds the pages scrolled so far
// (infinite scroll), so a search also asks the database. Like WhatsApp,
// results come in two groups: conversations whose contact matches (name
// or phone) and individual messages whose text matches.

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

/**
 * Lower-case and strip accents ("Orçamento" -> "orcamento") one character
 * at a time, so every index in the result is the same index in the
 * original text — the snippet below cuts the ORIGINAL at a match found in
 * the folded copy. Mirrors the database's search_fold (migration 111).
 */
export function foldForSearch(s: string): string {
  let out = '';
  for (const ch of s) {
    const base = ch.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    // Keep one output char per input char (an odd multi-char fold keeps
    // the original) so positions line up.
    out += (base.length === ch.length ? base : ch).toLowerCase();
  }
  return out;
}

export interface Snippet {
  before: string;
  match: string;
  after: string;
}

/**
 * The part of a message around the first match, for a result row: up to
 * `radius` characters each side, with an ellipsis where it was cut. The
 * match ignores case and accents ("orcamento" highlights "Orçamento");
 * when it is still not found, the start of the text is shown.
 */
export function snippetAround(
  text: string,
  term: string,
  radius = 40
): Snippet {
  const flat = text.replace(/\s+/g, ' ').trim();
  const at = foldForSearch(flat).indexOf(foldForSearch(term));
  if (at < 0 || !term) {
    const cut = flat.length > radius * 2;
    return {
      before: cut ? `${flat.slice(0, radius * 2)}…` : flat,
      match: '',
      after: '',
    };
  }
  const start = Math.max(0, at - radius);
  const end = Math.min(flat.length, at + term.length + radius);
  return {
    before: (start > 0 ? '…' : '') + flat.slice(start, at),
    match: flat.slice(at, at + term.length),
    after: flat.slice(at + term.length, end) + (end < flat.length ? '…' : ''),
  };
}
