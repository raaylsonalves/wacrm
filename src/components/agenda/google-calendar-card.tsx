'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { formatDistanceToNow } from 'date-fns';
import { toast } from 'sonner';
import { CalendarCheck, Loader2, Unlink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { dateFnsLocale } from '@/lib/date-fns-locale';

interface Status {
  enabled: boolean;
  connection: {
    google_email: string;
    status: 'active' | 'needs_reauth' | 'disabled';
    last_synced_at: string | null;
    last_error: string | null;
    include_customer_phone: boolean;
  } | null;
}

/**
 * Google Agenda link for the account's shared calendar (migration 096):
 * connect, see the connected e-mail / last sync / problems, choose whether
 * the customer's phone goes into the event, disconnect. Admins only (the
 * dialog that renders it already is).
 */
export function GoogleCalendarCard() {
  const t = useTranslations('Agenda.google');
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch('/api/integrations/google-calendar', {
      cache: 'no-store',
    });
    setStatus(
      res.ok
        ? ((await res.json()) as Status)
        : { enabled: false, connection: null }
    );
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  if (!status) return null;

  if (!status.enabled) {
    return (
      <div className="border-border text-muted-foreground rounded-md border border-dashed p-3 text-xs">
        {t('notConfigured')}
      </div>
    );
  }

  const c = status.connection;

  async function disconnect() {
    if (!window.confirm(t('confirmDisconnect'))) return;
    setBusy(true);
    const res = await fetch('/api/integrations/google-calendar', {
      method: 'DELETE',
    });
    setBusy(false);
    if (!res.ok) return toast.error(t('failed'));
    toast.success(t('disconnected'));
    void load();
  }

  async function setPhone(value: boolean) {
    const res = await fetch('/api/integrations/google-calendar', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ include_customer_phone: value }),
    });
    if (!res.ok) return toast.error(t('failed'));
    void load();
  }

  return (
    <div className="border-border space-y-2 rounded-md border p-3">
      <div className="flex items-center gap-2 text-sm font-medium">
        <CalendarCheck className="text-primary size-4" />
        {t('title')}
      </div>

      {!c ? (
        <>
          <p className="text-muted-foreground text-xs">{t('pitch')}</p>
          <Button
            size="sm"
            onClick={() =>
              window.location.assign('/api/integrations/google-calendar/start')
            }
          >
            {t('connect')}
          </Button>
        </>
      ) : (
        <>
          <p className="text-sm">
            {t('connectedAs')}{' '}
            <strong className="break-all">{c.google_email}</strong>
          </p>
          {c.status === 'needs_reauth' ? (
            <div className="space-y-2 rounded-md bg-amber-500/10 p-2 text-xs text-amber-800 dark:text-amber-200">
              <p>{t('needsReauth')}</p>
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  window.location.assign(
                    '/api/integrations/google-calendar/start'
                  )
                }
              >
                {t('reconnect')}
              </Button>
            </div>
          ) : (
            <p className="text-muted-foreground text-xs">
              {c.last_synced_at
                ? t('lastSync', {
                    when: formatDistanceToNow(new Date(c.last_synced_at), {
                      addSuffix: true,
                      locale: dateFnsLocale,
                    }),
                  })
                : t('firstSyncPending')}
            </p>
          )}
          {c.last_error && c.status === 'active' && (
            <p className="text-xs text-red-600 dark:text-red-400">
              {c.last_error}
            </p>
          )}
          <label className="flex items-center gap-2 text-xs">
            <Checkbox
              checked={c.include_customer_phone}
              onCheckedChange={(v) => void setPhone(v === true)}
            />
            {t('includePhone')}
          </label>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void disconnect()}
          >
            {busy ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Unlink className="size-3.5" />
            )}
            {t('disconnect')}
          </Button>
        </>
      )}
    </div>
  );
}
