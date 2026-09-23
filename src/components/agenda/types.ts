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
  scheduled: 'border-primary/40 bg-primary/10 text-primary',
  confirmed: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  completed: 'border-border bg-muted text-muted-foreground',
  cancelled: 'border-border bg-muted text-muted-foreground line-through',
  no_show: 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300',
};
