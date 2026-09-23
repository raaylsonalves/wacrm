'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Loader2, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { localParts, zonedToUtc } from '@/lib/appointments/slots';
import { memberLabel } from '@/lib/account/members';
import type { AccountMember } from '@/types';
import { APPOINTMENT_STATUSES, type Appointment, type AppointmentStatus } from './types';

const SELECT_CLASS =
  'w-full rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-foreground focus:border-primary focus:outline-none';

const pad = (n: number) => String(n).padStart(2, '0');

interface ContactOption {
  id: string;
  name: string | null;
  phone: string | null;
}

export interface AppointmentDraft {
  /** Local date "YYYY-MM-DD" and time "HH:MM" in the account timezone. */
  date: string;
  time: string;
}

export function AppointmentDialog({
  open,
  onOpenChange,
  appointment,
  draft,
  timezone,
  slotMinutes,
  members,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  appointment: Appointment | null;
  draft: AppointmentDraft | null;
  timezone: string;
  slotMinutes: number;
  members: AccountMember[];
  onSaved: () => void;
}) {
  const t = useTranslations('Agenda');
  const { user, accountId, canSendMessages } = useAuth();
  // Initialized from props; the page remounts this dialog (via `key`)
  // each time it opens, so no reset effect is needed.
  const initial = (() => {
    if (!appointment) {
      return {
        contactId: '',
        contactQuery: '',
        title: '',
        date: draft?.date ?? '',
        time: draft?.time ?? '09:00',
        duration: slotMinutes,
        assignedTo: '',
        status: 'scheduled' as AppointmentStatus,
        notes: '',
      };
    }
    const start = new Date(appointment.starts_at);
    const p = localParts(start, timezone);
    return {
      contactId: appointment.contact_id,
      contactQuery: appointment.contact?.name ?? appointment.contact?.phone ?? '',
      title: appointment.title,
      date: `${p.year}-${pad(p.month)}-${pad(p.day)}`,
      time: `${pad(p.hour)}:${pad(p.minute)}`,
      duration: Math.round((new Date(appointment.ends_at).getTime() - start.getTime()) / 60_000),
      assignedTo: appointment.assigned_to ?? '',
      status: appointment.status,
      notes: appointment.notes ?? '',
    };
  })();
  const [contactQuery, setContactQuery] = useState(initial.contactQuery);
  const [contacts, setContacts] = useState<ContactOption[]>([]);
  const [contactId, setContactId] = useState(initial.contactId);
  const [title, setTitle] = useState(initial.title);
  const [date, setDate] = useState(initial.date);
  const [time, setTime] = useState(initial.time);
  const [duration, setDuration] = useState(initial.duration);
  const [assignedTo, setAssignedTo] = useState(initial.assignedTo);
  const [status, setStatus] = useState<AppointmentStatus>(initial.status);
  const [notes, setNotes] = useState(initial.notes);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open || contactId) return;
    // Commas/parens are PostgREST filter syntax inside .or().
    const q = contactQuery.trim().replace(/[,()]/g, ' ');
    const handle = setTimeout(async () => {
      const supabase = createClient();
      let query = supabase.from('contacts').select('id, name, phone').order('name').limit(8);
      if (q) query = query.or(`name.ilike.%${q}%,phone.ilike.%${q}%`);
      const { data } = await query;
      setContacts((data as ContactOption[] | null) ?? []);
    }, 250);
    return () => clearTimeout(handle);
  }, [open, contactQuery, contactId]);

  async function handleSave() {
    if (!accountId || !user) return;
    if (!contactId) return toast.error(t('dialog.contactRequired'));
    if (!title.trim()) return toast.error(t('dialog.titleRequired'));
    if (!date || !time || !Number.isFinite(duration) || duration <= 0) return toast.error(t('dialog.whenRequired'));

    const [y, mo, d] = date.split('-').map(Number);
    const [h, mi] = time.split(':').map(Number);
    const start = zonedToUtc(y, mo, d, h, mi, timezone);
    const end = new Date(start.getTime() + duration * 60_000);

    const row = {
      contact_id: contactId,
      title: title.trim(),
      notes: notes.trim() || null,
      starts_at: start.toISOString(),
      ends_at: end.toISOString(),
      assigned_to: assignedTo || null,
      status,
      updated_at: new Date().toISOString(),
    };

    setSaving(true);
    const supabase = createClient();
    const result = appointment
      ? await supabase
          .from('appointments')
          .update({
            ...row,
            // A moved appointment needs a fresh reminder.
            ...(new Date(appointment.starts_at).getTime() !== start.getTime()
              ? { reminder_sent_at: null }
              : {}),
          })
          .eq('id', appointment.id)
      : await supabase
          .from('appointments')
          .insert({ ...row, account_id: accountId, created_by: user.id, source: 'manual' });
    setSaving(false);

    if (result.error) {
      toast.error(
        result.error.code === '23P01' ? t('dialog.conflict') : t('dialog.saveFailed'),
      );
      return;
    }
    toast.success(t('dialog.saved'));
    onSaved();
    onOpenChange(false);
  }

  async function handleDelete() {
    if (!appointment || !confirm(t('dialog.deleteConfirm'))) return;
    const { error } = await createClient().from('appointments').delete().eq('id', appointment.id);
    if (error) return toast.error(t('dialog.saveFailed'));
    onSaved();
    onOpenChange(false);
  }

  const readOnly = !canSendMessages;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-border bg-popover sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{appointment ? t('dialog.editTitle') : t('dialog.newTitle')}</DialogTitle>
        </DialogHeader>

        <div className="min-w-0 space-y-3">
          <div className="space-y-1.5">
            <Label className="text-muted-foreground">{t('dialog.contact')}</Label>
            <Input
              value={contactQuery}
              disabled={readOnly}
              placeholder={t('dialog.contactPlaceholder')}
              onChange={(e) => {
                setContactQuery(e.target.value);
                setContactId('');
              }}
            />
            {!contactId && contacts.length > 0 && (
              <ul className="border-border max-h-40 overflow-y-auto rounded-md border">
                {contacts.map((c) => (
                  <li key={c.id}>
                    <button
                      type="button"
                      className="hover:bg-muted w-full px-2 py-1.5 text-left text-sm"
                      onClick={() => {
                        setContactId(c.id);
                        setContactQuery(c.name ?? c.phone ?? '');
                      }}
                    >
                      {c.name ?? c.phone}
                      {c.name && c.phone && (
                        <span className="text-muted-foreground ml-2 text-xs">{c.phone}</span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="space-y-1.5">
            <Label className="text-muted-foreground">{t('dialog.title')}</Label>
            <Input
              value={title}
              disabled={readOnly}
              placeholder={t('dialog.titlePlaceholder')}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>

          <div className="grid grid-cols-3 gap-2">
            <div className="col-span-3 space-y-1.5 sm:col-span-1">
              <Label className="text-muted-foreground">{t('dialog.date')}</Label>
              <Input type="date" value={date} disabled={readOnly} onChange={(e) => setDate(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-muted-foreground">{t('dialog.time')}</Label>
              <Input type="time" value={time} disabled={readOnly} onChange={(e) => setTime(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-muted-foreground">{t('dialog.duration')}</Label>
              <Input
                type="number"
                min={5}
                step={5}
                value={duration}
                disabled={readOnly}
                onChange={(e) => setDuration(Number(e.target.value))}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1.5">
              <Label className="text-muted-foreground">{t('dialog.assignedTo')}</Label>
              <select
                className={SELECT_CLASS}
                value={assignedTo}
                disabled={readOnly}
                onChange={(e) => setAssignedTo(e.target.value)}
              >
                <option value="">{t('dialog.shared')}</option>
                {members.map((m) => (
                  <option key={m.user_id} value={m.user_id}>
                    {memberLabel(m)}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-muted-foreground">{t('dialog.status')}</Label>
              <select
                className={SELECT_CLASS}
                value={status}
                disabled={readOnly}
                onChange={(e) => setStatus(e.target.value as AppointmentStatus)}
              >
                {APPOINTMENT_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {t(`status.${s}`)}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label className="text-muted-foreground">{t('dialog.notes')}</Label>
            <textarea
              className={`${SELECT_CLASS} min-h-16`}
              value={notes}
              disabled={readOnly}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
        </div>

        <DialogFooter>
          {appointment && !readOnly && (
            <Button variant="outline" onClick={handleDelete} className="sm:mr-auto">
              <Trash2 className="size-4" />
              {t('dialog.delete')}
            </Button>
          )}
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('dialog.cancel')}
          </Button>
          {!readOnly && (
            <Button onClick={handleSave} disabled={saving}>
              {saving && <Loader2 className="size-4 animate-spin" />}
              {t('dialog.save')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
