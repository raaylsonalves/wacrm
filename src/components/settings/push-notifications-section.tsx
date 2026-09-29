'use client';

import { useEffect, useState } from 'react';
import { CircleAlert, Loader2, Share, Smartphone } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import {
  disablePush,
  enablePush,
  getCurrentPushSubscription,
  getPushSupport,
} from '@/hooks/use-push-registration';
import type { PushSupport } from '@/lib/pwa';

/**
 * Web Push toggle (specs/pwa-web-push-notifications.md) — the only
 * alert that reaches a closed browser or a locked phone. Rendered
 * regardless of the tab-alert support check above it: an iPhone in a
 * Safari tab has no Notification API at all, and that is exactly the
 * case that needs the "Add to Home Screen" instructions.
 */
export function PushNotificationsSection() {
  const t = useTranslations('Settings.browserNotifications.push');

  // Undetermined until mounted — support depends on browser globals.
  const [support, setSupport] = useState<PushSupport | null>(null);
  const [subscribed, setSubscribed] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const s = getPushSupport();
    getCurrentPushSubscription()
      .then((sub) => {
        if (cancelled) return;
        setSupport(s);
        setSubscribed(sub !== null);
      })
      .catch(() => {
        if (!cancelled) setSupport(s);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (support === null) return null;

  const onToggle = async (next: boolean) => {
    setBusy(true);
    try {
      if (next) {
        await enablePush();
        setSubscribed(true);
        toast.success(t('enabledToast'));
      } else {
        await disablePush();
        setSubscribed(false);
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : '';
      toast.error(
        reason === 'denied'
          ? t('deniedToast')
          : reason === 'not-configured'
            ? t('notConfigured')
            : t('enableFailed')
      );
    } finally {
      setBusy(false);
    }
  };

  const sendTest = async () => {
    setBusy(true);
    try {
      const res = await fetch('/api/notifications/push-test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: t('testTitle'), body: t('testBody') }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok || !payload.sent) throw new Error(payload?.error || 'failed');
      toast.success(t('testSent'));
    } catch {
      toast.error(t('testFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border-border space-y-3 border-t pt-4">
      {support === 'ios-needs-install' ? (
        <div className="border-primary/30 bg-primary/5 text-foreground flex items-start gap-2 rounded-md border px-3 py-2 text-xs">
          <Smartphone className="text-primary mt-0.5 size-4 shrink-0" />
          <div className="space-y-1">
            <p className="font-medium">{t('iosInstallTitle')}</p>
            <p className="text-muted-foreground flex flex-wrap items-center gap-1">
              {t('iosInstallStep1')}
              <Share className="inline size-3.5" />
              {t('iosInstallStep2')}
            </p>
          </div>
        </div>
      ) : support === 'unsupported' ? (
        <p className="text-muted-foreground flex items-center gap-2 text-sm">
          <CircleAlert className="size-4 shrink-0" />
          {t('unsupported')}
        </p>
      ) : (
        <>
          <div className="border-border flex items-center justify-between gap-4 rounded-md border p-3">
            <div className="min-w-0">
              <p className="text-foreground text-sm font-medium">
                {t('toggleLabel')}
              </p>
              <p className="text-muted-foreground text-xs">{t('toggleDesc')}</p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {busy && (
                <Loader2 className="text-muted-foreground size-4 animate-spin" />
              )}
              <Switch
                checked={subscribed}
                onCheckedChange={(next) => void onToggle(next)}
                disabled={busy}
                aria-label={t('toggleLabel')}
              />
            </div>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void sendTest()}
            disabled={!subscribed || busy}
          >
            <Smartphone className="size-4" />
            {t('sendTest')}
          </Button>
        </>
      )}
    </div>
  );
}
