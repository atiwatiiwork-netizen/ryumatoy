/* Ryuma service worker — Web Push only (no offline caching).
   Receives a JSON payload {title, body, url} and shows a notification;
   tapping it opens the target page (or focuses an open tab). */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch { data = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(data.title || 'Ryuma', {
    body: data.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { url: data.url || '/' },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  // SECURITY: only ever open a SAME-ORIGIN path — a payload url must never navigate a trusted "Ryuma"
  // notification to an external site (phishing). Coerce anything off-origin back to the home path.
  let url = '/';
  try { const u = new URL((e.notification.data && e.notification.data.url) || '/', self.location.origin); url = u.origin === self.location.origin ? u.pathname + u.search + u.hash : '/'; } catch { url = '/'; }
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((tabs) => {
    for (const t of tabs) { if ('focus' in t) { t.navigate(url); return t.focus(); } }
    return self.clients.openWindow(url);
  }));
});
