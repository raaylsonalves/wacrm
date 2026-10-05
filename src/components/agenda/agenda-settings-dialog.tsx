'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { SaveButton } from '@/components/ui/save-button';
import { Switch } from '@/components/ui/switch';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { useIsDesktop } from '@/components/ui/side-panel';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import {
  isValidTimeZone,
  type AppointmentSettings,
} from '@/lib/appointments/slots';
import { templateVarCount } from '@/lib/appointments/followup';
import { cn } from '@/lib/utils';
import { GoogleCalendarCard } from './google-calendar-card';

/** Monday first, as the calendar shows it. */
const DAYS = [1, 2, 3, 4, 5, 6, 0];
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
/** Postgres `time` accepts 24:00, and every reader works in minutes. */
const END_OF_DAY = '24:00';

const fieldCls =
  'border-border bg-card text-foreground focus:border-foreground w-full min-w-0 rounded-2xl border-[1.5px] px-3 py-2.5 text-sm font-semibold transition-colors duration-150 ease-out outline-none';

interface FollowupTemplate {
  id: string;
  name: string;
  body_text: string | null;
}

export function isAllDay(
  s: Pick<AppointmentSettings, 'work_days' | 'day_start' | 'day_end'>
) {
  return (
    s.work_days.length === 7 &&
    s.day_start.slice(0, 5) === '00:00' &&
    s.day_end.slice(0, 5) === END_OF_DAY
  );
}

export function AgendaSettingsDialog({
  open,
  onOpenChange,
  settings,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  settings: AppointmentSettings;
  onSaved: () => void;
}) {
  const isDesktop = useIsDesktop();
  const t = useTranslations('Agenda');
  const body = open ? (
    <SettingsForm
      settings={settings}
      onCancel={() => onOpenChange(false)}
      onSaved={() => {
        onSaved();
        onOpenChange(false);
      }}
    />
  ) : null;

  if (isDesktop) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="flex max-h-[90dvh] flex-col gap-0 p-0 sm:max-w-[520px]">
          <div className="px-6 pt-5 pb-2">
            <DialogTitle className="text-xl font-extrabold tracking-[-0.01em]">
              {t('settings.title')}
            </DialogTitle>
            <DialogDescription className="mt-1">
              {t('settings.description')}
            </DialogDescription>
          </div>
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
        className="flex max-h-[92dvh] flex-col gap-0 p-0"
      >
        <div className="flex justify-center pt-2.5 pb-1" aria-hidden>
          <span className="bg-border h-1.5 w-11 rounded-full" />
        </div>
        <SheetTitle className="px-5 pt-1 text-xl font-extrabold">
          {t('settings.title')}
        </SheetTitle>
        <p className="text-muted-foreground px-5 pb-2 text-sm">
          {t('settings.description')}
        </p>
        {body}
      </SheetContent>
    </Sheet>
  );
}

function SettingsForm({
  settings,
  onCancel,
  onSaved,
}: {
  settings: AppointmentSettings;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const t = useTranslations('Agenda');
  const { accountId } = useAuth();
  const [form, setForm] = useState(settings);
  const [saving, setSaving] = useState(false);
  const [templates, setTemplates] = useState<FollowupTemplate[]>([]);
  const allDay = isAllDay(form);
  // What the hours were before switching to 24h, so switching back
  // restores them instead of an empty day.
  const [beforeAllDay, setBeforeAllDay] = useState(() =>
    isAllDay(settings)
      ? { work_days: [1, 2, 3, 4, 5], day_start: '09:00', day_end: '18:00' }
      : {
          work_days: settings.work_days,
          day_start: settings.day_start,
          day_end: settings.day_end,
        }
  );

  // Approved templates the cron can fill on its own: no media header, no
  // carousel, and at most one variable ({{1}} = the customer's first name).
  useEffect(() => {
    if (!accountId) return;
    let alive = true;
    createClient()
      .from('message_templates')
      .select('id, name, body_text, header_type, components')
      .eq('account_id', accountId)
      .ilike('status', 'approved')
      .order('name')
      .then(({ data }) => {
        if (!alive) return;
        setTemplates(
          (data ?? []).filter(
            (tpl) =>
              (!tpl.header_type || tpl.header_type === 'text') &&
              !/carousel/i.test(JSON.stringify(tpl.components ?? '')) &&
              templateVarCount(tpl.body_text) <= 1
          )
        );
      });
    return () => {
      alive = false;
    };
  }, [accountId]);

  function setAllDay(on: boolean) {
    if (on) {
      setBeforeAllDay({
        work_days: form.work_days,
        day_start: form.day_start,
        day_end: form.day_end,
      });
      setForm({
        ...form,
        work_days: ALL_DAYS,
        day_start: '00:00',
        day_end: END_OF_DAY,
      });
    } else {
      setForm({ ...form, ...beforeAllDay });
    }
  }

  function toggleDay(day: number) {
    setForm((f) => ({
      ...f,
      work_days: f.work_days.includes(day)
        ? f.work_days.filter((d) => d !== day)
        : [...f.work_days, day].sort(),
    }));
  }

  async function handleSave() {
    if (!accountId) return;
    if (!allDay && form.day_end.slice(0, 5) <= form.day_start.slice(0, 5)) {
      return toast.error(t('settings.invalidHours'));
    }
    if (!isValidTimeZone(form.timezone.trim())) {
      return toast.error(t('settings.invalidTimezone'));
    }
    if (form.followup_enabled && !form.followup_template_id) {
      return toast.error(t('settings.followupPickTemplate'));
    }
    setSaving(true);
    const { error } = await createClient()
      .from('appointment_settings')
      .upsert({
        ...form,
        timezone: form.timezone.trim(),
        account_id: accountId,
        updated_at: new Date().toISOString(),
      });
    setSaving(false);
    if (error) return toast.error(t('settings.saveFailed'));
    toast.success(t('settings.saved'));
    onSaved();
  }

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-5 pt-2 pb-4 lg:px-6">
        {/* Hours */}
        <section className="border-border flex flex-col gap-3 rounded-[22px] border p-4">
          <label className="flex items-start gap-3">
            <span className="flex min-w-0 flex-1 flex-col">
              <strong className="text-sm">{t('settings.allDay')}</strong>
              <span className="text-muted-foreground text-xs">
                {t('settings.allDayHint')}
              </span>
            </span>
            <Switch checked={allDay} onCheckedChange={setAllDay} />
          </label>

          {!allDay && (
            <>
              <div className="flex flex-col gap-1.5">
                <span className="text-muted-foreground text-[12.5px] font-bold">
                  {t('settings.workDays')}
                </span>
                <div className="flex flex-wrap gap-1.5">
                  {DAYS.map((d) => {
                    const on = form.work_days.includes(d);
                    return (
                      <button
                        key={d}
                        type="button"
                        aria-pressed={on}
                        onClick={() => toggleDay(d)}
                        className={cn(
                          'min-h-9 min-w-12 rounded-full border px-3 text-[12.5px] font-bold transition-colors duration-150 ease-out',
                          on
                            ? 'bg-foreground text-background border-transparent'
                            : 'border-border bg-card hover:bg-muted'
                        )}
                      >
                        {t(`weekdays.${d}`)}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2.5">
                <label className="flex flex-col gap-1.5">
                  <span className="text-muted-foreground text-[12.5px] font-bold">
                    {t('settings.dayStart')}
                  </span>
                  <input
                    type="time"
                    value={form.day_start.slice(0, 5)}
                    onChange={(e) =>
                      setForm({ ...form, day_start: e.target.value })
                    }
                    className={cn(fieldCls, 'tabular-nums')}
                  />
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className="text-muted-foreground text-[12.5px] font-bold">
                    {t('settings.dayEnd')}
                  </span>
                  <input
                    type="time"
                    value={
                      form.day_end.slice(0, 5) === END_OF_DAY
                        ? '23:59'
                        : form.day_end.slice(0, 5)
                    }
                    onChange={(e) =>
                      setForm({ ...form, day_end: e.target.value })
                    }
                    className={cn(fieldCls, 'tabular-nums')}
                  />
                </label>
              </div>
            </>
          )}

          <div className="grid grid-cols-[1fr_1.6fr] gap-2.5">
            <label className="flex flex-col gap-1.5">
              <span className="text-muted-foreground text-[12.5px] font-bold">
                {t('settings.slotMinutes')}
              </span>
              <input
                type="number"
                min={5}
                max={480}
                step={5}
                value={form.slot_minutes}
                onChange={(e) =>
                  setForm({ ...form, slot_minutes: Number(e.target.value) })
                }
                className={cn(fieldCls, 'tabular-nums')}
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-muted-foreground text-[12.5px] font-bold">
                {t('settings.timezone')}
              </span>
              <input
                value={form.timezone}
                onChange={(e) => setForm({ ...form, timezone: e.target.value })}
                className={fieldCls}
              />
            </label>
          </div>
        </section>

        {/* Reminder */}
        <section className="border-border flex flex-col gap-3 rounded-[22px] border p-4">
          <label className="flex items-center gap-3">
            <strong className="flex-1 text-sm">
              {t('settings.reminderEnabled')}
            </strong>
            <Switch
              checked={form.reminder_enabled}
              onCheckedChange={(c) => setForm({ ...form, reminder_enabled: c })}
            />
          </label>
          {form.reminder_enabled && (
            <>
              <label className="flex flex-col gap-1.5">
                <span className="text-muted-foreground text-[12.5px] font-bold">
                  {t('settings.reminderHours')}
                </span>
                <input
                  type="number"
                  min={1}
                  max={168}
                  value={form.reminder_hours_before}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      reminder_hours_before: Number(e.target.value),
                    })
                  }
                  className={cn(fieldCls, 'max-w-32 tabular-nums')}
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-muted-foreground text-[12.5px] font-bold">
                  {t('settings.reminderText')}
                </span>
                <textarea
                  value={form.reminder_text}
                  onChange={(e) =>
                    setForm({ ...form, reminder_text: e.target.value })
                  }
                  className={cn(
                    fieldCls,
                    'min-h-20 resize-none leading-relaxed font-normal'
                  )}
                />
                <span className="text-muted-foreground text-xs">
                  {t('settings.reminderHint', {
                    vars: '{{nome}}, {{data}}, {{hora}}',
                  })}
                </span>
              </label>
            </>
          )}
        </section>

        {/* After the appointment */}
        <section className="border-border flex flex-col gap-3 rounded-[22px] border p-4">
          <label className="flex items-center gap-3">
            <strong className="flex-1 text-sm">
              {t('settings.followupEnabled')}
            </strong>
            <Switch
              checked={form.followup_enabled}
              onCheckedChange={(c) => setForm({ ...form, followup_enabled: c })}
            />
          </label>
          {form.followup_enabled && (
            <>
              <label className="flex flex-col gap-1.5">
                <span className="text-muted-foreground text-[12.5px] font-bold">
                  {t('settings.followupDays')}
                </span>
                <input
                  type="number"
                  min={1}
                  max={90}
                  value={form.followup_days_after}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      followup_days_after: Number(e.target.value),
                    })
                  }
                  className={cn(fieldCls, 'max-w-32 tabular-nums')}
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-muted-foreground text-[12.5px] font-bold">
                  {t('settings.followupTemplate')}
                </span>
                <select
                  value={form.followup_template_id ?? ''}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      followup_template_id: e.target.value || null,
                    })
                  }
                  className={fieldCls}
                >
                  <option value="">{t('settings.followupNoTemplate')}</option>
                  {templates.map((tpl) => (
                    <option key={tpl.id} value={tpl.id}>
                      {tpl.name}
                    </option>
                  ))}
                </select>
                <span className="text-muted-foreground text-xs">
                  {t.raw('settings.followupHint') as string}
                </span>
              </label>
            </>
          )}
        </section>

        <GoogleCalendarCard />
      </div>

      <div className="border-border flex flex-col-reverse gap-2 border-t px-5 pt-3 pb-5 sm:flex-row sm:justify-end lg:px-6">
        <Button
          variant="outline"
          className="h-11 px-4 sm:h-10"
          onClick={onCancel}
        >
          {t('dialog.cancel')}
        </Button>
        <SaveButton
          className="h-12 px-5 sm:h-10"
          saving={saving}
          onClick={handleSave}
        >
          {t('dialog.save')}
        </SaveButton>
      </div>
    </>
  );
}
