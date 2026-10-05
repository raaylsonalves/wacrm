'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { zonedToUtc } from '@/lib/appointments/slots';
import type { ContactLite } from '@/hooks/queries/use-crm-lookups';
import { ContactPicker } from '@/components/pipelines/contact-picker';
import { useIsDesktop } from '@/components/ui/side-panel';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export interface AppointmentDraft {
  /** Local date "YYYY-MM-DD" and time "HH:MM" in the account timezone. */
  date: string;
  time: string;
}

const fieldCls =
  'border-border bg-card text-foreground focus:border-foreground rounded-2xl border-[1.5px] px-3.5 py-3 text-base font-bold transition-colors duration-150 ease-out outline-none';

/**
 * v8 quick create: who, what and when. Owner, status and notes are set on
 * the appointment view ("Agendar e abrir" jumps straight there). A small
 * dialog on desktop, a bottom sheet on phones.
 */
export function AppointmentQuickCreate({
  open,
  onOpenChange,
  draft,
  timezone,
  slotMinutes,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  draft: AppointmentDraft | null;
  timezone: string;
  slotMinutes: number;
  /** Called with the new appointment's id; `openPanel` when asked to open it. */
  onCreated: (id: string, openPanel: boolean) => void;
}) {
  const isDesktop = useIsDesktop();
  const t = useTranslations('Agenda');
  const body = open ? (
    <QuickForm
      draft={draft}
      timezone={timezone}
      slotMinutes={slotMinutes}
      onDone={(id, openPanel) => {
        onOpenChange(false);
        onCreated(id, openPanel);
      }}
    />
  ) : null;

  if (isDesktop) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="gap-0 p-0 sm:max-w-[480px]">
          <DialogTitle className="px-6 pt-5 pb-1 text-xl font-extrabold tracking-[-0.01em]">
            {t('dialog.newTitle')}
          </DialogTitle>
          {body}
        </DialogContent>
      </Dialog>
    );
  }
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        showCloseButton={false}
        className="max-h-[92dvh] gap-0 overflow-y-auto p-0"
      >
        <div className="flex justify-center pt-2.5 pb-1" aria-hidden>
          <span className="bg-border h-1.5 w-11 rounded-full" />
        </div>
        <SheetTitle className="px-5 pt-1 pb-1 text-xl font-extrabold">
          {t('dialog.newTitle')}
        </SheetTitle>
        {body}
      </SheetContent>
    </Sheet>
  );
}

function QuickForm({
  draft,
  timezone,
  slotMinutes,
  onDone,
}: {
  draft: AppointmentDraft | null;
  timezone: string;
  slotMinutes: number;
  onDone: (id: string, openPanel: boolean) => void;
}) {
  const t = useTranslations('Agenda');
  const { user, accountId } = useAuth();
  const [contact, setContact] = useState<ContactLite | null>(null);
  const [title, setTitle] = useState('');
  const [date, setDate] = useState(draft?.date ?? '');
  const [time, setTime] = useState(draft?.time ?? '09:00');
  const [duration, setDuration] = useState(slotMinutes);
  const [busy, setBusy] = useState<false | 'plain' | 'open'>(false);
  const lengths = [...new Set([15, 30, 45, 60, 90, slotMinutes])].sort(
    (a, b) => a - b
  );

  async function create(openPanel: boolean) {
    if (busy || !accountId || !user) return;
    if (!contact) return void toast.error(t('dialog.contactRequired'));
    if (!title.trim()) return void toast.error(t('dialog.titleRequired'));
    if (!date || !time) return void toast.error(t('dialog.whenRequired'));
    const [y, mo, d] = date.split('-').map(Number);
    const [h, mi] = time.split(':').map(Number);
    const start = zonedToUtc(y, mo, d, h, mi, timezone);
    const end = new Date(start.getTime() + duration * 60_000);

    setBusy(openPanel ? 'open' : 'plain');
    const { data, error } = await createClient()
      .from('appointments')
      .insert({
        account_id: accountId,
        created_by: user.id,
        source: 'manual',
        contact_id: contact.id,
        title: title.trim(),
        starts_at: start.toISOString(),
        ends_at: end.toISOString(),
        status: 'scheduled',
      })
      .select('id')
      .single();
    if (error || !data) {
      toast.error(
        error?.code === '23P01' ? t('dialog.conflict') : t('dialog.saveFailed')
      );
      setBusy(false);
      return;
    }
    if (!openPanel) {
      toast.success(t('dialog.saved'), {
        action: {
          label: t('panel.open'),
          onClick: () => onDone(data.id, true),
        },
      });
    }
    onDone(data.id, openPanel);
  }

  return (
    <form
      className="flex flex-col"
      onSubmit={(e) => {
        e.preventDefault();
        void create(false);
      }}
    >
      <div className="flex flex-col gap-4 px-5 pt-3 pb-2 lg:px-6">
        <div className="flex flex-col gap-1.5">
          <span className="text-muted-foreground text-[12.5px] font-bold">
            {t('dialog.contact')}
          </span>
          <ContactPicker value={contact} onChange={setContact} autoFocus />
        </div>
        <label className="flex flex-col gap-1.5">
          <span className="text-muted-foreground text-[12.5px] font-bold">
            {t('dialog.title')}
          </span>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t('dialog.titlePlaceholder')}
            className={fieldCls}
          />
        </label>
        <div className="grid grid-cols-[1.4fr_1fr] gap-3">
          <label className="flex min-w-0 flex-col gap-1.5">
            <span className="text-muted-foreground text-[12.5px] font-bold">
              {t('dialog.date')}
            </span>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className={cn(fieldCls, 'min-w-0')}
            />
          </label>
          <label className="flex min-w-0 flex-col gap-1.5">
            <span className="text-muted-foreground text-[12.5px] font-bold">
              {t('dialog.time')}
            </span>
            <input
              type="time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
              className={cn(fieldCls, 'min-w-0 tabular-nums')}
            />
          </label>
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-muted-foreground text-[12.5px] font-bold">
            {t('panel.length')}
          </span>
          <div className="flex flex-wrap gap-1.5">
            {lengths.map((n) => (
              <button
                key={n}
                type="button"
                aria-pressed={n === duration}
                onClick={() => setDuration(n)}
                className={cn(
                  'min-h-9 rounded-full border px-3 text-[12.5px] font-bold tabular-nums transition-colors duration-150 ease-out',
                  n === duration
                    ? 'bg-foreground text-background border-transparent'
                    : 'border-border bg-card hover:bg-muted'
                )}
              >
                {t('panel.minutes', { n })}
              </button>
            ))}
          </div>
        </div>
        <p className="text-muted-foreground text-[12.5px]">
          {t('panel.quickHint')}
        </p>
      </div>
      <div className="flex flex-col-reverse gap-2 px-5 pt-3 pb-5 sm:flex-row sm:justify-end lg:px-6">
        <Button
          type="button"
          variant="outline"
          className="h-11 px-4 sm:h-10"
          disabled={!!busy}
          onClick={() => void create(true)}
        >
          {busy === 'open' && <Loader2 className="size-4 animate-spin" />}
          {t('panel.createAndOpen')}
        </Button>
        <Button
          type="submit"
          className="h-12 px-5 text-[15px] sm:h-10 sm:text-sm"
          disabled={!!busy}
        >
          {busy === 'plain' && <Loader2 className="size-4 animate-spin" />}
          {t('panel.schedule')}
        </Button>
      </div>
    </form>
  );
}
