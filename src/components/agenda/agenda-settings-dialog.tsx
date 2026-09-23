'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { isValidTimeZone, type AppointmentSettings } from '@/lib/appointments/slots';

const DAYS = [0, 1, 2, 3, 4, 5, 6];

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
  const t = useTranslations('Agenda');
  const { accountId } = useAuth();
  // Seeded from props; the page remounts this dialog (via `key`) on open.
  const [form, setForm] = useState(settings);
  const [saving, setSaving] = useState(false);

  function toggleDay(day: number, checked: boolean) {
    setForm((f) => ({
      ...f,
      work_days: checked
        ? [...f.work_days, day].sort()
        : f.work_days.filter((d) => d !== day),
    }));
  }

  async function handleSave() {
    if (!accountId) return;
    if (form.day_end.slice(0, 5) <= form.day_start.slice(0, 5)) {
      return toast.error(t('settings.invalidHours'));
    }
    if (!isValidTimeZone(form.timezone.trim())) {
      return toast.error(t('settings.invalidTimezone'));
    }
    setSaving(true);
    const { error } = await createClient()
      .from('appointment_settings')
      .upsert({ ...form, timezone: form.timezone.trim(), account_id: accountId, updated_at: new Date().toISOString() });
    setSaving(false);
    if (error) return toast.error(t('settings.saveFailed'));
    toast.success(t('settings.saved'));
    onSaved();
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-border bg-popover sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('settings.title')}</DialogTitle>
          <DialogDescription>{t('settings.description')}</DialogDescription>
        </DialogHeader>

        <div className="min-w-0 space-y-4">
          <div className="space-y-1.5">
            <Label className="text-muted-foreground">{t('settings.workDays')}</Label>
            <div className="flex flex-wrap gap-3">
              {DAYS.map((d) => (
                <label key={d} className="flex items-center gap-1.5 text-sm">
                  <Checkbox
                    checked={form.work_days.includes(d)}
                    onCheckedChange={(c) => toggleDay(d, c === true)}
                  />
                  {t(`weekdays.${d}`)}
                </label>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-3 gap-2">
            <div className="space-y-1.5">
              <Label className="text-muted-foreground">{t('settings.dayStart')}</Label>
              <Input
                type="time"
                value={form.day_start.slice(0, 5)}
                onChange={(e) => setForm({ ...form, day_start: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-muted-foreground">{t('settings.dayEnd')}</Label>
              <Input
                type="time"
                value={form.day_end.slice(0, 5)}
                onChange={(e) => setForm({ ...form, day_end: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-muted-foreground">{t('settings.slotMinutes')}</Label>
              <Input
                type="number"
                min={5}
                max={480}
                step={5}
                value={form.slot_minutes}
                onChange={(e) => setForm({ ...form, slot_minutes: Number(e.target.value) })}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label className="text-muted-foreground">{t('settings.timezone')}</Label>
            <Input
              value={form.timezone}
              onChange={(e) => setForm({ ...form, timezone: e.target.value })}
            />
          </div>

          <div className="border-border space-y-2 rounded-md border p-3">
            <label className="flex items-center gap-2 text-sm font-medium">
              <Checkbox
                checked={form.reminder_enabled}
                onCheckedChange={(c) => setForm({ ...form, reminder_enabled: c === true })}
              />
              {t('settings.reminderEnabled')}
            </label>
            <div className="space-y-1.5">
              <Label className="text-muted-foreground">{t('settings.reminderHours')}</Label>
              <Input
                type="number"
                min={1}
                max={168}
                value={form.reminder_hours_before}
                onChange={(e) =>
                  setForm({ ...form, reminder_hours_before: Number(e.target.value) })
                }
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-muted-foreground">{t('settings.reminderText')}</Label>
              <textarea
                className="border-border bg-muted text-foreground min-h-16 w-full rounded-md border px-2 py-1.5 text-sm"
                value={form.reminder_text}
                onChange={(e) => setForm({ ...form, reminder_text: e.target.value })}
              />
              <p className="text-muted-foreground text-xs">{t('settings.reminderHint', { vars: '{{nome}}, {{data}}, {{hora}}' })}</p>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('dialog.cancel')}
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving && <Loader2 className="size-4 animate-spin" />}
            {t('dialog.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
