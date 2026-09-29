'use client';

import { useCallback, useEffect, useState } from 'react';

import {
  disablePush,
  enablePush,
  getCurrentPushSubscription,
  getPushSupport,
} from '@/hooks/use-push-registration';
import { writeBrowserNotifyPref } from '@/lib/notifications/browser-notify';
import type { PushSupport } from '@/lib/pwa';

/** Fired after any instance turns push on/off, so the header icon,
 *  the inbox banner and Settings all reflect it without a reload. */
const PUSH_CHANGE_EVENT = 'wacrm:push-change';

export type PushErrorReason = 'denied' | 'not-configured' | 'failed';

export interface PushControl {
  /** null until mounted — support depends on browser globals. */
  support: PushSupport | null;
  /** Whether this deployment has VAPID keys; null while loading. */
  configured: boolean | null;
  subscribed: boolean;
  busy: boolean;
  enable: () => Promise<PushErrorReason | null>;
  disable: () => Promise<void>;
  sendTest: (title: string, body: string) => Promise<boolean>;
}

/**
 * Shared state + actions for this device's push subscription. Every
 * entry point (Settings, header icon, onboarding step, inbox banner)
 * uses this so they can't disagree about whether push is on.
 */
export function usePushControl(): PushControl {
  const [support, setSupport] = useState<PushSupport | null>(null);
  const [subscribed, setSubscribed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [configured, setConfigured] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/notifications/push-subscription')
      .then((res) => (res.ok ? res.json() : { configured: false }))
      .then((cfg: { configured?: boolean }) => {
        if (!cancelled) setConfigured(Boolean(cfg.configured));
      })
      .catch(() => {
        if (!cancelled) setConfigured(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
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
    };
    refresh();
    window.addEventListener(PUSH_CHANGE_EVENT, refresh);
    return () => {
      cancelled = true;
      window.removeEventListener(PUSH_CHANGE_EVENT, refresh);
    };
  }, []);

  const enable = useCallback(async (): Promise<PushErrorReason | null> => {
    setBusy(true);
    try {
      await enablePush();
      // Permission is granted now anyway — turn on the tab-open alert
      // too, so "enable notifications" means one thing to the user.
      writeBrowserNotifyPref(true);
      setSubscribed(true);
      window.dispatchEvent(new Event(PUSH_CHANGE_EVENT));
      return null;
    } catch (err) {
      const reason = err instanceof Error ? err.message : '';
      return reason === 'denied' || reason === 'not-configured'
        ? reason
        : 'failed';
    } finally {
      setBusy(false);
    }
  }, []);

  const disable = useCallback(async () => {
    setBusy(true);
    try {
      await disablePush();
      setSubscribed(false);
      window.dispatchEvent(new Event(PUSH_CHANGE_EVENT));
    } finally {
      setBusy(false);
    }
  }, []);

  const sendTest = useCallback(async (title: string, body: string) => {
    setBusy(true);
    try {
      const res = await fetch('/api/notifications/push-test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, body }),
      });
      const payload = await res.json().catch(() => ({}));
      return res.ok && Boolean(payload.sent);
    } catch {
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  return { support, configured, subscribed, busy, enable, disable, sendTest };
}

/**
 * Whether to nudge the user to turn push on: the deployment supports
 * it, this device could do it (or could after installing, on iOS), and
 * it's not on yet. Pure so the gate is unit-tested.
 */
export function shouldNudgePush(
  c: Pick<PushControl, 'support' | 'configured' | 'subscribed'>
): boolean {
  return (
    c.configured === true &&
    (c.support === 'supported' || c.support === 'ios-needs-install') &&
    !c.subscribed
  );
}
