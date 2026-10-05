'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Ellipsis, ExternalLink, X } from 'lucide-react';
import { toast } from 'sonner';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { appLocaleTag, localParts, zonedToUtc } from '@/lib/appointments/slots';
import { memberLabel } from '@/lib/account/members';
import { InlineField } from '@/components/ui/inline-field';
import { PickRow } from '@/components/ui/pick-row';
import { SaveState, SidePanel } from '@/components/ui/side-panel';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import type { AccountMember } from '@/types';
import {
  APPOINTMENT_STATUSES,
  eventToneClass,
  type Appointment,
} from './types';

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * v8 appointment view: beside the calendar on desktop, a bottom sheet on
 * phones. Every field saves on its own; date, time and length are saved
 * together as starts_at/ends_at so a move is one write (and clears the
 * sent reminder, as the old dialog did).
 */
export function AppointmentPanel({
  appointment,
  timezone,
  members,
  onClose,
  onChanged,
}: {
  appointment: Appointment | null;
  timezone: string;
  members: AccountMember[];
  onClose: () => void;
  /** Refetch the calendar after a write. */
  onChanged: () => void;
}) {
  const t = useTranslations('Agenda');
  return (
    <SidePanel open={!!appointment} onClose={onClose} label={t('panel.title')}>
      {appointment && (
        <PanelBody
          key={appointment.id}
          initial={appointment}
          timezone={timezone}
          members={members}
          onClose={onClose}
          onChanged={onChanged}
        />
      )}
    </SidePanel>
  );
}

function PanelBody({
  initial,
  timezone,
  members,
  onClose,
  onChanged,
}: {
  initial: Appointment;
  timezone: string;
  members: AccountMember[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const t = useTranslations('Agenda');
  const { canSendMessages } = useAuth();
  const readOnly = !canSendMessages;
  const [a, setA] = useState(initial);
  const [pending, setPending] = useState(0);
  const [failed, setFailed] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const start = new Date(a.starts_at);
  const p = localParts(start, timezone);
  const date = `${p.year}-${pad(p.month)}-${pad(p.day)}`;
  const time = `${pad(p.hour)}:${pad(p.minute)}`;
  const duration = Math.round(
    (new Date(a.ends_at).getTime() - start.getTime()) / 60_000
  );
  const dateLabel = new Intl.DateTimeFormat(appLocaleTag(), {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: timezone,
  }).format(start);

  async function save(patch: Partial<Appointment> & Record<string, unknown>) {
    const prev = a;
    setA({ ...a, ...patch });
    setPending((n) => n + 1);
    setFailed(false);
    const { error } = await createClient()
      .from('appointments')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', a.id);
    setPending((n) => n - 1);
    if (error) {
      setA(prev);
      setFailed(true);
      toast.error(
        error.code === '23P01' ? t('dialog.conflict') : t('dialog.saveFailed')
      );
      return;
    }
    setSavedAt(Date.now());
    onChanged();
  }

  function saveWhen(next: { date?: string; time?: string; duration?: number }) {
    const d = next.date ?? date;
    const h = next.time ?? time;
    const len = next.duration ?? duration;
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(d) ||
      !/^\d{2}:\d{2}$/.test(h) ||
      !(len > 0)
    ) {
      toast.error(t('dialog.whenRequired'));
      return;
    }
    const [y, mo, day] = d.split('-').map(Number);
    const [hh, mi] = h.split(':').map(Number);
    const s = zonedToUtc(y, mo, day, hh, mi, timezone);
    const e = new Date(s.getTime() + len * 60_000);
    void save({
      starts_at: s.toISOString(),
      ends_at: e.toISOString(),
      ...(s.getTime() !== start.getTime() ? { reminder_sent_at: null } : {}),
    });
  }

  async function remove() {
    const { error } = await createClient()
      .from('appointments')
      .delete()
      .eq('id', a.id);
    if (error) {
      toast.error(t('dialog.saveFailed'));
      return;
    }
    toast.success(t('panel.deleted'));
    onClose();
    onChanged();
  }

  const who = a.contact?.name ?? a.contact?.phone ?? a.title;
  const owner = members.find((m) => m.user_id === a.assigned_to);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 px-5 pt-4">
        <span className="text-muted-foreground text-xs font-bold">
          {t(`grid.source.${a.source}`)}
        </span>
        <span className="flex-1" />
        <SaveState pending={pending > 0} failed={failed} savedAt={savedAt} />
        <DropdownMenu onOpenChange={(o) => !o && setConfirmDelete(false)}>
          <DropdownMenuTrigger
            aria-label={t('panel.moreActions')}
            className="hover:bg-muted flex size-9 items-center justify-center rounded-full transition-colors duration-150 ease-out"
          >
            <Ellipsis className="size-5" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-60">
            {a.conversation_id && (
              <DropdownMenuItem
                render={<Link href={`/inbox?c=${a.conversation_id}`} />}
              >
                <ExternalLink className="size-4" />
                {t('grid.openConversation')}
              </DropdownMenuItem>
            )}
            {!readOnly &&
              (confirmDelete ? (
                <div className="flex flex-col gap-2 px-2.5 py-2">
                  <span className="text-sm font-semibold">
                    {t('dialog.deleteConfirm')}
                  </span>
                  <div className="flex gap-1.5">
                    <button
                      type="button"
                      onClick={remove}
                      className="bg-tone-pink-soft text-tone-pink-ink min-h-8 rounded-full px-3 text-[12.5px] font-bold"
                    >
                      {t('dialog.delete')}
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmDelete(false)}
                      className="bg-muted min-h-8 rounded-full px-3 text-[12.5px] font-semibold"
                    >
                      {t('dialog.cancel')}
                    </button>
                  </div>
                </div>
              ) : (
                <DropdownMenuItem
                  variant="destructive"
                  closeOnClick={false}
                  onClick={() => setConfirmDelete(true)}
                >
                  {t('panel.delete')}…
                </DropdownMenuItem>
              ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('panel.close')}
          className="hover:bg-muted flex size-9 items-center justify-center rounded-full transition-colors duration-150 ease-out"
        >
          <X className="size-4.5" />
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 pt-2 pb-5">
        <InlineField
          layout="bare"
          label={t('dialog.title')}
          value={a.title}
          disabled={readOnly}
          onSave={(v) =>
            v ? void save({ title: v }) : toast.error(t('dialog.titleRequired'))
          }
          className="text-xl"
          inputClassName="text-xl font-extrabold"
          display={
            <span className="text-xl font-extrabold tracking-[-0.01em]">
              {a.title}
            </span>
          }
        />

        <div
          className={cn(
            'flex flex-col gap-1 rounded-[22px] border p-4',
            eventToneClass(a)
          )}
        >
          <strong className="text-lg leading-tight font-bold">{who}</strong>
          <span className="text-[13.5px] tabular-nums first-letter:uppercase">
            {dateLabel} · {time}–
            {(() => {
              const q = localParts(new Date(a.ends_at), timezone);
              return `${pad(q.hour)}:${pad(q.minute)}`;
            })()}
          </span>
        </div>

        <section className="flex flex-col">
          <span className="text-muted-foreground mb-1 text-xs font-bold">
            {t('panel.when')}
          </span>
          <InlineField
            label={t('dialog.date')}
            type="date"
            value={date}
            disabled={readOnly}
            display={
              <span className="first-letter:uppercase">{dateLabel}</span>
            }
            onSave={(v) => saveWhen({ date: v })}
          />
          <InlineField
            label={t('dialog.time')}
            type="time"
            value={time}
            disabled={readOnly}
            onSave={(v) => saveWhen({ time: v })}
          />
          <PickRow
            label={t('panel.length')}
            value={t('panel.minutes', { n: duration })}
            selected={String(duration)}
            disabled={readOnly}
            options={[...new Set([15, 30, 45, 60, 90, 120, duration])]
              .sort((x, y) => x - y)
              .map((n) => ({
                id: String(n),
                label: t('panel.minutes', { n }),
              }))}
            onPick={(id) => saveWhen({ duration: Number(id) })}
          />
        </section>

        <section className="flex flex-col">
          <span className="text-muted-foreground mb-1 text-xs font-bold">
            {t('panel.details')}
          </span>
          <PickRow
            label={t('dialog.status')}
            value={t(`status.${a.status}`)}
            selected={a.status}
            disabled={readOnly}
            options={APPOINTMENT_STATUSES.map((s) => ({
              id: s,
              label: t(`status.${s}`),
            }))}
            onPick={(id) => void save({ status: id as Appointment['status'] })}
          />
          <PickRow
            label={t('dialog.assignedTo')}
            value={owner ? memberLabel(owner) : t('dialog.shared')}
            selected={a.assigned_to ?? ''}
            disabled={readOnly}
            options={[
              { id: '', label: t('dialog.shared') },
              ...members.map((m) => ({ id: m.user_id, label: memberLabel(m) })),
            ]}
            onPick={(id) => void save({ assigned_to: id || null })}
          />
        </section>

        <section className="flex flex-col">
          <span className="text-muted-foreground mb-1 text-xs font-bold">
            {t('dialog.notes')}
          </span>
          <InlineField
            layout="bare"
            multiline
            label={t('dialog.notes')}
            value={a.notes ?? ''}
            placeholder={t('panel.addNotes')}
            disabled={readOnly}
            onSave={(v) => void save({ notes: v || null })}
            className="bg-muted min-h-14 items-start py-3"
          />
        </section>
      </div>

      <p className="text-muted-foreground border-border border-t px-5 py-3 text-xs">
        {t('panel.hint')}
      </p>
    </div>
  );
}
