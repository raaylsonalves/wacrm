// Pictures an AI agent may send (migration 140). Pure: shared by the
// send_image tool (lib/ai/tools/media.ts), the save routes and the
// agent editor, so it must not import server code.

export interface MediaItem {
  id: string;
  name: string;
  /** When to send it, in the account's words. */
  when: string;
  url: string;
}

export const MEDIA_LIBRARY_MAX = 10;
/** The same picture again inside this window is refused. */
export const MEDIA_DEDUPE_MS = 12 * 60 * 60_000;

/** Sanitised library from the stored jsonb (or a request body). */
export function parseMediaLibrary(raw: unknown): MediaItem[] {
  if (!Array.isArray(raw)) return [];
  const out: MediaItem[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const str = (v: unknown, max: number) =>
      typeof v === 'string' ? v.trim().slice(0, max) : '';
    const url = str(o.url, 1000);
    const name = str(o.name, 80);
    if (!/^https:\/\//.test(url) || !name) continue;
    const id =
      str(o.id, 40).replace(/[^a-z0-9_-]/gi, '') || `img${out.length + 1}`;
    if (out.some((x) => x.id === id)) continue;
    out.push({ id, name, when: str(o.when, 300), url });
    if (out.length >= MEDIA_LIBRARY_MAX) break;
  }
  return out;
}
