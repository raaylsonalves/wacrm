/**
 * LGPD anonymization helpers for a single contact — the "right to be
 * forgotten" cousin of opt-out (`lib/contacts/opt-out.ts`). Wired into
 * `POST /api/contacts/[id]/anonymize`.
 *
 * Anonymization, not deletion: conversations, messages and deals stay
 * in place — only identifying fields are wiped, so the business keeps
 * its own records (revenue history, message counts) intact. Message
 * *media* is the exception: photos/documents/audio are personal data
 * in their own right and get removed from Storage, same as the
 * contact's other PII.
 */

/** Fields cleared on the `contacts` row. Pure — no DB access. */
export interface AnonymizedContactFields {
  name: string;
  phone: string;
  email: null;
  company: null;
  avatar_url: null;
  wa_user_id: null;
  wa_parent_user_id: null;
  wa_username: null;
  anonymized_at: string;
}

/**
 * `phone` and `wa_user_id` both back a UNIQUE index scoped to
 * `account_id` (migrations 022 and 040), and both indexes are
 * `WHERE ... <> ''` / `WHERE ... IS NOT NULL` — i.e. they deliberately
 * exclude the empty/null case so more than one anonymized contact per
 * account never collides. `phone` must stay a non-null string
 * (`NOT NULL` column) so it goes to `''`; the wa_* fields go to `null`.
 *
 * `name` becomes "Cliente Anonimizado #<8 chars of the id>" — enough
 * to tell two anonymized rows apart in a list without keeping any of
 * the original name.
 */
export function buildAnonymizedContactFields(
  contactId: string,
  now: Date = new Date()
): AnonymizedContactFields {
  return {
    name: `Cliente Anonimizado #${contactId.slice(0, 8)}`,
    phone: '',
    email: null,
    company: null,
    avatar_url: null,
    wa_user_id: null,
    wa_parent_user_id: null,
    wa_username: null,
    anonymized_at: now.toISOString(),
  };
}

/**
 * Extracts the `{ bucket, path }` a Supabase Storage public URL points
 * at, so a media message can be deleted by path rather than by
 * re-deriving it. Returns `null` for anything that isn't a Supabase
 * public-object URL (a message can have `media_url` pointing
 * elsewhere, or already be `null`).
 *
 * Matches the `/storage/v1/object/public/<bucket>/<path>` shape both
 * `uploadAccountMedia` (lib/storage/upload-media.ts) and the inbound
 * mirror (lib/whatsapp/mirror-inbound-media.ts) produce.
 */
export function parseStorageObjectUrl(
  url: string
): { bucket: string; path: string } | null {
  const match = url.match(/\/storage\/v1\/object\/public\/([^/]+)\/(.+)$/);
  if (!match) return null;
  const [, bucket, encodedPath] = match;
  try {
    return { bucket, path: decodeURIComponent(encodedPath) };
  } catch {
    return null;
  }
}
