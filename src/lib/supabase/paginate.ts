// PostgREST answers at most `max-rows` rows per request (1000 on
// Supabase) and drops the rest WITHOUT an error. Any read that must see
// every row — a broadcast audience, a tag's members — pages through with
// fetchAllRows instead of trusting a single select. Long id lists are
// split with `chunk`, since `.in(...)` travels in the URL.

/** Supabase's default `max-rows`; a page shorter than this is the last. */
export const PAGE_ROWS = 1000;

/** Ids per `.in(...)` filter: keeps the request URL well under limits. */
export const IN_CHUNK = 200;

interface PageResult<T> {
  data: T[] | null;
  error: { message: string } | null;
}

/**
 * Reads every page of a query. `page(from, to)` must build a FRESH query
 * with a stable `.order(...)` and `.range(from, to)` on each call.
 */
export async function fetchAllRows<T>(
  page: (from: number, to: number) => PromiseLike<PageResult<T>>,
  size = PAGE_ROWS
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += size) {
    const { data, error } = await page(from, from + size - 1);
    if (error) throw new Error(error.message);
    const batch = data ?? [];
    rows.push(...batch);
    if (batch.length < size) return rows;
  }
}

export function chunk<T>(items: T[], size = IN_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}
