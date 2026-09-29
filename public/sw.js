// wacrm service worker — Web Push only (specs/pwa-web-push-notifications.md).
//
// Deliberately NO `fetch` handler and no caching: this is a live-data
// dashboard, and serving a stale inbox offline would mislead an agent
// into replying from old state. The worker exists to receive pushes and
// open the right conversation when one is tapped.

self.addEventListener('install', () => {
  // Nothing to precache — activate the new version immediately.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : '' };
  }

  const title = data.title || 'wacrm';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || '',
      // One alert per conversation — a second message from the same
      // customer replaces the first, same as the tab-open alert.
      tag: data.conversationId || undefined,
      renotify: Boolean(data.conversationId),
      // The account's logo (sent by the server); only our own icon route
      // is accepted, falling back to the default mark.
      icon:
        typeof data.icon === 'string' && data.icon.startsWith('/pwa-icon/')
          ? data.icon
          : '/pwa-icon/192',
      // Android shows the status-bar badge as a silhouette (alpha only),
      // so it needs a transparent glyph — an opaque square shows as an
      // empty box.
      badge: '/pwa-icon/badge',
      data: { url: data.url || '/inbox' },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(
    (event.notification.data && event.notification.data.url) || '/inbox',
    self.location.origin
  );
  // Only ever navigate within our own origin, whatever the payload says.
  if (target.origin !== self.location.origin) return;

  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });
      // Reuse an open app window rather than stacking new ones.
      for (const client of windows) {
        if (new URL(client.url).origin === self.location.origin) {
          await client.focus();
          if ('navigate' in client) {
            try {
              await client.navigate(target.href);
            } catch {
              // Uncontrolled client — fall through to openWindow.
              break;
            }
          }
          return;
        }
      }
      await self.clients.openWindow(target.href);
    })()
  );
});
