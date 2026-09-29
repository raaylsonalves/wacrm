'use client';

import { CircleAlert, Loader2, Share, Smartphone } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import type { PushControl } from '@/hooks/use-push-control';

/**
 * The push on/off control, shared by Settings, the header popover and
 * the onboarding step. Shown even without the Notification API: an
 * iPhone in a Safari tab has none, and that's exactly who needs the
 * "Add to Home Screen" instructions.
 *
 * The browser's permission prompt only ever opens from the user's own
 * click on the switch — prompting unprompted gets denied, and a denial
 * is effectively permanent in Chrome.
 */
export function PushControlPanel({
  control,
  showTest = true,
}: {
  control: PushControl;
  showTest?: boolean;
}) {
  const t = useTranslations('Settings.browserNotifications.push');
  const { support, subscribed, busy } = control;

  if (support === null) return null;

  if (support === 'ios-needs-install') {
    return (
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
    );
  }

  if (support === 'unsupported') {
    return (
      <p className="text-muted-foreground flex items-center gap-2 text-sm">
        <CircleAlert className="size-4 shrink-0" />
        {t('unsupported')}
      </p>
    );
  }

  const onToggle = async (next: boolean) => {
    if (!next) {
      await control.disable();
      return;
    }
    const error = await control.enable();
    if (!error) {
      toast.success(t('enabledToast'));
      return;
    }
    toast.error(
      error === 'denied'
        ? t('deniedToast')
        : error === 'not-configured'
          ? t('notConfigured')
          : t('enableFailed')
    );
  };

  const onTest = async () => {
    const ok = await control.sendTest(t('testTitle'), t('testBody'));
    if (ok) toast.success(t('testSent'));
    else toast.error(t('testFailed'));
  };

  return (
    <div className="space-y-3">
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
      {showTest && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void onTest()}
          disabled={!subscribed || busy}
        >
          <Smartphone className="size-4" />
          {t('sendTest')}
        </Button>
      )}
    </div>
  );
}
