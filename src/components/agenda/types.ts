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
  source: 'manual' | 'flow';
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
