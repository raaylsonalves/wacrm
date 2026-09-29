'use client';

import { useState } from 'react';
import { BellRing, Loader2, Share, X } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { shouldNudgePush, usePushControl } from '@/hooks/use-push-control';

const DISMISS_KEY = 'wacrm:push-nudge-dismissed';

function readDismissed(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(DISMISS_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * One-line nudge at the top of the Inbox for agents who haven't turned
 * push on on this device. Dismissible per device (the header icon keeps
 * offering it afterwards). "Ativar" is the user's own click, so the
 * browser's permission prompt only ever follows an explicit choice.
 */
export function PushNudgeBanner() {
  const t = useTranslations('Inbox.pushNudge');
  const tPush = useTranslations('Settings.browserNotifications.push');
  const control = usePushControl();
  const [dismissed, setDismissed] = useState(readDismissed);

  if (dismissed || !shouldNudgePush(control)) return null;

  const dismiss = () => {
    setDismissed(true);
    try {
      window.localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      // Private mode — hidden for this page's lifetime only.
    }
  };

  const enable = async () => {
    const error = await control.enable();
    if (!error) {
      toast.success(tPush('enabledToast'));
      return;
    }
    toast.error(
      error === 'denied'
        ? tPush('deniedToast')
        : error === 'not-configured'
          ? tPush('notConfigured')
          : tPush('enableFailed')
    );
  };

  const iosNeedsInstall = control.support === 'ios-needs-install';

  return (
    <div className="border-primary/20 bg-primary/5 flex shrink-0 items-center gap-3 border-b px-4 py-2">
      <BellRing className="text-primary h-4 w-4 shrink-0" />
      <p className="text-foreground min-w-0 flex-1 text-xs">
        {iosNeedsInstall ? (
          <span className="flex flex-wrap items-center gap-1">
            {t('iosText')}
            <Share className="inline size-3.5" />
            {t('iosText2')}
          </span>
        ) : (
          t('text')
        )}
      </p>
      {!iosNeedsInstall && (
        <Button
          size="sm"
          className="h-7 shrink-0 px-2.5 text-xs"
          onClick={() => void enable()}
          disabled={control.busy}
        >
          {control.busy && <Loader2 className="size-3 animate-spin" />}
          {t('enableBtn')}
        </Button>
      )}
      <button
        type="button"
        onClick={dismiss}
        aria-label={t('dismiss')}
        className="text-muted-foreground hover:text-foreground flex h-7 w-7 shrink-0 items-center justify-center rounded-md"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
