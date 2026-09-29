'use client';

import { useEffect } from 'react';

import {
  detectPushSupport,
  isIosDevice,
  urlBase64ToUint8Array,
  type PushSupport,
} from '@/lib/pwa';

// Web Push, client side (specs/pwa-web-push-notifications.md).

const SW_URL = '/sw.js';
const SUBSCRIPTION_API = '/api/notifications/push-subscription';

export function getPushSupport(): PushSupport {
  if (typeof window === 'undefined') return 'unsupported';
  return detectPushSupport({
    hasServiceWorker: 'serviceWorker' in navigator,
    hasPushManager: 'PushManager' in window,
    isIos: isIosDevice(navigator.userAgent, navigator.maxTouchPoints),
    isStandalone: isStandaloneDisplay(),
  });
}

export function isStandaloneDisplay(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    window.matchMedia?.('(display-mode: standalone)').matches ||
    // iOS Safari's own flag for a home-screen launch.
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

function registerServiceWorker(): Promise<ServiceWorkerRegistration> {
  // `updateViaCache: 'none'` so a new sw.js deploy is picked up on the
  // next load instead of after the HTTP cache expires.
  return navigator.serviceWorker.register(SW_URL, {
    scope: '/',
    updateViaCache: 'none',
  });
}

async function postSubscription(sub: PushSubscription): Promise<void> {
  const res = await fetch(SUBSCRIPTION_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(sub.toJSON()),
  });
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new Error(payload?.error || `HTTP ${res.status}`);
  }
}

/**
 * Show a notification through the service worker. Android Chrome throws
 * on `new Notification()` from a page (it requires a worker) — this is
 * the fallback for the tab-open alert and the test button. Resolves
 * false when there's no worker to show it with.
 */
export async function showNotificationViaWorker(
  title: string,
  options: NotificationOptions & { data?: { url?: string } }
): Promise<boolean> {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) {
    return false;
  }
  try {
    const reg =
      (await navigator.serviceWorker.getRegistration('/')) ??
      (await registerServiceWorker());
    await navigator.serviceWorker.ready;
    await reg.showNotification(title, options);
    return true;
  } catch (err) {
    console.warn('[push] showNotification via worker failed:', err);
    return false;
  }
}

/** This browser's current push subscription, if any. */
export async function getCurrentPushSubscription(): Promise<PushSubscription | null> {
  if (getPushSupport() !== 'supported') return null;
  const reg = await navigator.serviceWorker.getRegistration('/');
  return (await reg?.pushManager.getSubscription()) ?? null;
}

/**
 * Turn push on for this device: permission → SW → subscribe → save.
 * Throws with a user-presentable reason on failure.
 */
export async function enablePush(): Promise<void> {
  if (getPushSupport() !== 'supported') throw new Error('unsupported');

  const cfgRes = await fetch(SUBSCRIPTION_API);
  const cfg = (await cfgRes.json().catch(() => ({}))) as {
    configured?: boolean;
    publicKey?: string | null;
  };
  if (!cfg.configured || !cfg.publicKey) throw new Error('not-configured');

  const permission =
    Notification.permission === 'granted'
      ? 'granted'
      : await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('denied');

  const reg = await registerServiceWorker();
  await navigator.serviceWorker.ready;
  const existing = await reg.pushManager.getSubscription();
  const sub =
    existing ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(cfg.publicKey),
    }));
  await postSubscription(sub);
}

/** Turn push off for this device: forget it server-side, then unsubscribe. */
export async function disablePush(): Promise<void> {
  const sub = await getCurrentPushSubscription();
  if (!sub) return;
  await fetch(SUBSCRIPTION_API, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint: sub.endpoint }),
  }).catch(() => undefined);
  await sub.unsubscribe();
}

/**
 * Mount once per signed-in dashboard tab. Keeps the worker registered
 * and — when this device already has a subscription — re-saves it, which
 * self-heals the two ways a server row goes stale: the browser rotating
 * the endpoint, and a different user signing in on a shared device (the
 * row moves to whoever is signed in now). Never prompts for permission;
 * only the Settings toggle does that.
 */
export function usePushRegistration(): void {
  useEffect(() => {
    if (getPushSupport() !== 'supported') return;
    let cancelled = false;
    (async () => {
      try {
        const reg = await registerServiceWorker();
        const sub = await reg.pushManager.getSubscription();
        if (cancelled || !sub || Notification.permission !== 'granted') return;
        await postSubscription(sub);
      } catch (err) {
        // Non-fatal: the tab-open Realtime alert still works.
        console.warn('[push] registration failed:', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
}
