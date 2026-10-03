export type AppointmentStatus =
  | 'scheduled'
  | 'confirmed'
  | 'completed'
  | 'cancelled'
  | 'no_show';

export const APPOINTMENT_STATUSES: AppointmentStatus[] = [
  'scheduled',
  'confirmed',
  'completed',
  'cancelled',
  'no_show',
];

export interface Appointment {
  id: string;
  account_id: string;
  contact_id: string;
  conversation_id: string | null;
  assigned_to: string | null;
  title: string;
  notes: string | null;
  starts_at: string;
  ends_at: string;
  status: AppointmentStatus;
  /** Who booked it: a teammate, a Flow, or the AI agent (migration 061). */
  source: 'manual' | 'flow' | 'ai';
  contact: { id: string; name: string | null; phone: string | null } | null;
}

export const STATUS_CLASS: Record<AppointmentStatus, string> = {
  // v2 agenda: live appointments on solid pastel with ink text (readable
  // on every accent and mode), finished ones fade into the surface.
  scheduled: 'border-transparent bg-tone-lilac text-tone-on',
  confirmed: 'border-transparent bg-tone-mint text-tone-on',
  completed: 'border-border bg-muted text-muted-foreground',
  cancelled: 'border-border bg-muted text-muted-foreground line-through',
  no_show: 'border-transparent bg-tone-salmon-soft text-tone-salmon-ink',
};

/**
 * Colour of a live appointment by who booked it (v2): mint when the AI or
 * a Flow did, lilac when a teammate did. Finished ones use STATUS_CLASS.
 */
export function eventToneClass(a: Pick<Appointment, 'status' | 'source'>): string {
  if (a.status === 'scheduled' || a.status === 'confirmed') {
    return a.source === 'manual'
      ? 'border-transparent bg-tone-lilac text-tone-on'
      : 'border-transparent bg-tone-mint text-tone-on';
  }
  return STATUS_CLASS[a.status];
}
