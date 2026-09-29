"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { createClient } from "@/lib/supabase/client";
import type { Message } from "@/types";
import { showNotificationViaWorker } from "@/hooks/use-push-registration";
import { useAccountNotificationIcon } from "@/hooks/use-account-notification-icon";
import { PUSH_BADGE_URL } from "@/lib/pwa";
import {
  DEFAULT_NOTIFICATION_LABELS,
  buildNotificationContent,
  conversationHref,
  getNotificationPermission,
  pickContactDisplayName,
  readBrowserNotifyPref,
  shouldNotifyForMessage,
  subscribeBrowserNotifyPref,
  viewedConversationFromLocation,
  type NotificationLabels,
} from "@/lib/notifications/browser-notify";

const serverSnapshot = () => false;

/**
 * The device-scoped "browser notifications" opt-in, kept in sync with
 * localStorage across this tab (settings toggle) and other tabs.
 */
export function useBrowserNotifyPref(): boolean {
  return useSyncExternalStore(
    subscribeBrowserNotifyPref,
    readBrowserNotifyPref,
    serverSnapshot,
  );
}

/**
 * Desktop notifications for new inbound customer messages. Mount ONCE
 * per signed-in dashboard tab (the dashboard shell does this via
 * <BrowserNotificationsListener />) so alerts fire on any page.
 *
 * Listens for realtime INSERTs on `messages` — RLS scopes the stream to
 * the caller's account, same as useTotalUnread / useRealtime. Only
 * live events are considered: there is no initial fetch, so an existing
 * backlog never produces a burst of alerts on page load.
 *
 * Own channel name so it coexists with the inbox page's subscription
 * and the sidebar's unread counters.
 *
 * Fires only while a dashboard tab is open. Alerts for a closed browser
 * or locked phone come from Web Push instead (src/lib/push/send.ts +
 * public/sw.js); both coexist by design.
 */
export function useBrowserNotifications(): void {
  const enabled = useBrowserNotifyPref();
  const router = useRouter();
  const t = useTranslations("Settings.browserNotifications.labels");

  // Translated labels, read inside the async Realtime callback. Kept in
  // a ref (assigned in an effect, not during render) so a locale change
  // doesn't tear down and re-open the channel.
  const labelsRef = useRef<NotificationLabels>(DEFAULT_NOTIFICATION_LABELS);
  useEffect(() => {
    labelsRef.current = {
      fallbackTitle: t("fallbackTitle"),
      image: t("image"),
      audio: t("audio"),
      video: t("video"),
      document: t("document"),
      location: t("location"),
      template: t("template"),
    };
  });

  // Message ids already handled, for replay dedupe. Survives re-renders,
  // pruned by shouldNotifyForMessage.
  const seenRef = useRef<Map<string, number>>(new Map());

  // Account logo for the alert icon; a ref for the same no-resubscribe
  // reason as the labels above.
  const accountIcon = useAccountNotificationIcon();
  const iconRef = useRef(accountIcon);
  useEffect(() => {
    iconRef.current = accountIcon;
  });

  useEffect(() => {
    if (!enabled) return;
    if (getNotificationPermission() === "unsupported") return;

    const supabase = createClient();
    let cancelled = false;

    const notify = async (msg: Message) => {
      // One small select to put the contact's name in the title. A
      // failure here just means the generic fallback title.
      const { data } = await supabase
        .from("conversations")
        .select("contact:contacts(name, wa_username, phone)")
        .eq("id", msg.conversation_id)
        .maybeSingle();
      if (cancelled) return;

      const contact = (data as {
        contact?: { name?: string | null; wa_username?: string | null; phone?: string | null } | null;
      } | null)?.contact;
      const { title, body } = buildNotificationContent(
        msg,
        pickContactDisplayName(contact),
        labelsRef.current,
      );

      try {
        const notification = new Notification(title, {
          body,
          // One alert per conversation: a second message from the same
          // customer replaces the first instead of stacking.
          tag: msg.conversation_id,
          icon: iconRef.current,
          badge: PUSH_BADGE_URL,
        });
        notification.onclick = () => {
          window.focus();
          router.push(conversationHref(msg.conversation_id));
          notification.close();
        };
      } catch {
        // Android Chrome throws from the constructor — page-created
        // notifications need a service worker there. Show it through
        // the push worker instead; its notificationclick opens the same
        // conversation.
        const shown = await showNotificationViaWorker(title, {
          body,
          tag: msg.conversation_id,
          icon: iconRef.current,
          badge: PUSH_BADGE_URL,
          data: { url: conversationHref(msg.conversation_id) },
        });
        if (!shown) {
          console.error("[useBrowserNotifications] failed to show notification");
        }
      }
    };

    const channel = supabase
      .channel("browser-notifications")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "messages" },
        (payload) => {
          // Re-check every time: the user can revoke permission in the
          // browser without the preference flipping.
          if (getNotificationPermission() !== "granted") return;
          const msg = payload.new as Message;
          const shouldNotify = shouldNotifyForMessage(msg, {
            documentVisible: document.visibilityState === "visible",
            viewingConversationId: viewedConversationFromLocation(
              window.location.pathname,
              window.location.search,
            ),
            seen: seenRef.current,
          });
          if (!shouldNotify) return;
          void notify(msg);
        },
      )
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, [enabled, router]);
}
