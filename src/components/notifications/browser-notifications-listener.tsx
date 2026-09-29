"use client";

import { useBrowserNotifications } from "@/hooks/use-browser-notifications";
import { usePushRegistration } from "@/hooks/use-push-registration";

/**
 * Headless. Mount ONCE per signed-in dashboard tab (the dashboard
 * shell, below the auth gate) so desktop notifications for new customer
 * messages fire on every dashboard page, not just the inbox — and so
 * the Web Push service worker stays registered and in sync.
 */
export function BrowserNotificationsListener() {
  useBrowserNotifications();
  usePushRegistration();
  return null;
}
