'use client';

import { useSyncExternalStore } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog';

/**
 * In-app replacement for window.confirm. The native prompt is browser
 * chrome: embedded browsers (and "block dialogs on this page") suppress
 * it, and the click then silently did nothing. Call
 * `await confirmDialog(message)` anywhere; <ConfirmHost/> in the root
 * layout renders the question with the app's own dialog.
 */

type Request = {
  message: string;
  confirmLabel?: string;
  destructive?: boolean;
  resolve: (ok: boolean) => void;
};

let current: Request | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function confirmDialog(
  message: string,
  opts: { confirmLabel?: string; destructive?: boolean } = {}
): Promise<boolean> {
  // A second question replaces the first, which counts as cancelled.
  current?.resolve(false);
  return new Promise((resolve) => {
    current = { message, destructive: true, ...opts, resolve };
    emit();
  });
}

function settle(ok: boolean) {
  const req = current;
  current = null;
  emit();
  req?.resolve(ok);
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function ConfirmHost() {
  const t = useTranslations('Common.confirmDialog');
  const req = useSyncExternalStore(
    subscribe,
    () => current,
    () => null
  );
  return (
    <Dialog open={req !== null} onOpenChange={(open) => !open && settle(false)}>
      <DialogContent position="center" showCloseButton={false}>
        <DialogTitle className="text-lg">{t('title')}</DialogTitle>
        <DialogDescription className="whitespace-pre-line">
          {req?.message}
        </DialogDescription>
        <DialogFooter>
          <Button variant="outline" onClick={() => settle(false)}>
            {t('cancel')}
          </Button>
          <Button
            autoFocus
            variant={req?.destructive === false ? 'default' : 'destructive'}
            onClick={() => settle(true)}
          >
            {req?.confirmLabel ?? t('confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
