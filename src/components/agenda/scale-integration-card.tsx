'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Loader2, Scissors } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { confirmDialog } from '@/components/confirm-dialog';

interface Status {
  connected: boolean;
  enabled: boolean;
  label: string | null;
  last_error: string | null;
}

/**
 * ScaLE booking system link (migration 130): paste the shop's integration
 * key, and the AI agenda tools book in ScaLE instead of the own calendar.
 * The key is checked against the API before it is saved and is never
 * shown again. Admins only (the dialog that renders it already is).
 */
export function ScaleIntegrationCard() {
  const t = useTranslations('Agenda.scale');
  const [status, setStatus] = useState<Status | null>(null);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch('/api/integrations/scale', { cache: 'no-store' });
    setStatus(res.ok ? ((await res.json()) as Status) : null);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  async function save() {
    setBusy(true);
    const res = await fetch('/api/integrations/scale', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: key.trim() }),
    });
    setBusy(false);
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      return toast.error(
        body.error === 'key_rejected' ? t('keyRejected') : t('failed')
      );
    }
    setKey('');
    toast.success(t('connected'));
    void load();
  }

  async function setEnabled(enabled: boolean) {
    const res = await fetch('/api/integrations/scale', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    if (!res.ok) return toast.error(t('failed'));
    void load();
  }

  async function disconnect() {
    await confirmDialog(t('confirmDisconnect'), {
      action: async () => {
        const res = await fetch('/api/integrations/scale', {
          method: 'DELETE',
        });
        if (!res.ok) return toast.error(t('failed'));
        toast.success(t('disconnected'));
        void load();
      },
    });
  }

  if (!status) return null;

  return (
    <div className="border-border space-y-2 rounded-md border p-3">
      <div className="flex items-center gap-2 text-sm font-medium">
        <Scissors className="text-primary size-4" />
        {t('title')}
      </div>

      {!status.connected ? (
        <>
          <p className="text-muted-foreground text-xs">{t('pitch')}</p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              id="scale-api-key"
              type="password"
              autoComplete="off"
              placeholder={t('keyPlaceholder')}
              value={key}
              onChange={(e) => setKey(e.target.value)}
            />
            <Button
              size="sm"
              onClick={save}
              disabled={busy || key.trim().length < 16}
            >
              {busy && <Loader2 className="size-4 animate-spin" />}
              {t('connect')}
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="text-sm">
            {t('connectedTo')} <strong>{status.label}</strong>
          </p>
          <label className="flex items-center justify-between gap-3 text-xs">
            <span className="text-muted-foreground">{t('enabledHint')}</span>
            <Switch checked={status.enabled} onCheckedChange={setEnabled} />
          </label>
          {status.last_error && (
            <p className="rounded-md bg-amber-500/10 p-2 text-xs text-amber-800 dark:text-amber-200">
              {t('lastError', { error: status.last_error })}
            </p>
          )}
          <Button size="sm" variant="outline" onClick={disconnect}>
            {t('disconnect')}
          </Button>
        </>
      )}
    </div>
  );
}
