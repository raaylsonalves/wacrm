/**
 * Which composer media kind a pasted / dropped file becomes. Mirrors the
 * chat-media bucket's allowed types (migration 023): anything the bucket
 * would refuse returns null so the composer can say so before uploading.
 */
export type DroppedMediaKind = 'image' | 'video' | 'document' | 'audio';

const IMAGE = new Set(['image/png', 'image/jpeg', 'image/webp']);
const VIDEO = new Set(['video/mp4', 'video/3gpp']);
const AUDIO = new Set([
  'audio/ogg',
  'audio/mpeg',
  'audio/mp4',
  'audio/aac',
  'audio/amr',
]);
const DOCUMENT = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain',
]);

export function mediaKindForFile(file: {
  type: string;
}): DroppedMediaKind | null {
  const type = (file.type || '').toLowerCase().split(';')[0].trim();
  if (IMAGE.has(type)) return 'image';
  if (VIDEO.has(type)) return 'video';
  if (AUDIO.has(type)) return 'audio';
  if (DOCUMENT.has(type)) return 'document';
  return null;
}

/** Inserts `insert` at the textarea selection and returns the new value
 *  plus where the caret should land. */
export function insertAtCaret(
  value: string,
  start: number | null | undefined,
  end: number | null | undefined,
  insert: string
): { value: string; caret: number } {
  const s = start ?? value.length;
  const e = end ?? s;
  return {
    value: value.slice(0, s) + insert + value.slice(e),
    caret: s + insert.length,
  };
}
