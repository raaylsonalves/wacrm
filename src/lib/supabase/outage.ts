// Tracks whether the Supabase API is answering, from the browser's point of
// view. On 2026-10-10 PostgREST wedged its connection pool for ~1h20 and every
// request returned 503/504; each page swallowed the error and rendered empty,
// so the account looked wiped. The browser client's fetch reports every
// response here and the OutageBanner shows a "server unstable" bar instead.

/** Consecutive failures before we call it an outage (one blip is noise). */
export const OUTAGE_THRESHOLD = 3;

export interface OutageState {
  failures: number;
  down: boolean;
}

export const initialOutage: OutageState = { failures: 0, down: false };

/** A response is an outage signal when the gateway or the API failed. */
export function isOutageStatus(status: number | null): boolean {
  // null = the request never got a response (network error, timeout).
  return status === null || status === 502 || status === 503 || status === 504;
}

/** Pure reducer: fold one response into the state. */
export function nextOutage(
  state: OutageState,
  status: number | null
): OutageState {
  if (!isOutageStatus(status))
    return state.failures === 0 && !state.down ? state : initialOutage;
  const failures = state.failures + 1;
  return { failures, down: state.down || failures >= OUTAGE_THRESHOLD };
}

// ---- tiny external store (useSyncExternalStore) ----

let state: OutageState = initialOutage;
const listeners = new Set<() => void>();

export function getOutage(): OutageState {
  return state;
}

export function subscribeOutage(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function reportStatus(status: number | null): void {
  const next = nextOutage(state, status);
  if (next === state) return;
  state = next;
  listeners.forEach((fn) => fn());
}

/** fetch wrapper for the browser Supabase client. Never changes the result. */
export const trackedFetch: typeof fetch = async (input, init) => {
  try {
    const res = await fetch(input, init);
    reportStatus(res.status);
    return res;
  } catch (err) {
    // An abort is the caller's choice, not an outage.
    if (!(err instanceof DOMException && err.name === 'AbortError'))
      reportStatus(null);
    throw err;
  }
};
