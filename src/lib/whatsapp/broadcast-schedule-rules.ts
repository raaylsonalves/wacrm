// Pure rules for scheduled broadcasts — no server imports, so the wizard
// (a client component) can use them. The cron runner lives in
// broadcast-schedule.ts.

/** A scheduled time must be at least this far ahead when created. */
export const MIN_LEAD_MS = 5 * 60 * 1000;

export function canCancelBroadcast(status: string): boolean {
  return status === 'scheduled';
}

/** A datetime chosen in the wizard: valid only if far enough ahead. */
export function validScheduleTime(
  iso: string | null | undefined,
  now: number
): boolean {
  if (!iso) return false;
  const at = new Date(iso).getTime();
  return Number.isFinite(at) && at - now >= MIN_LEAD_MS;
}

export interface PendingRow {
  id: string;
  contact:
    | { opted_out_at?: string | null }
    | { opted_out_at?: string | null }[]
    | null;
}

/** Recipient rows whose contact opted out since the audience was frozen. */
export function optedOutRecipientIds(rows: PendingRow[]): string[] {
  return rows
    .filter((r) => {
      const c = Array.isArray(r.contact) ? r.contact[0] : r.contact;
      return !!c?.opted_out_at;
    })
    .map((r) => r.id);
}
