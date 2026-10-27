/*
 * MNAB service worker.
 *
 * It makes the dashboard installable as a Home Screen web app, shows a
 * friendly offline page instead of the browser's error screen, and turns
 * Web Push messages into notifications (bottom of this file). It is deliberately
 * NOT an offline cache of the app:
 *
 *  - Nothing the app normally loads is cached. /api/*, pages, shared JS/CSS
 *    all go straight to the network, so balances are never stale and a new
 *    deploy shows up on the next load, exactly as without a service worker.
 *  - The only cached files are the offline page and its icon (PRECACHE).
 *    When a page navigation fails because there's no network, the offline
 *    page is shown instead.
 *
 * '/offline' (not '/offline.html'): vercel.json sets cleanUrls, so
 * '/offline.html' answers with a 308 redirect, and Safari refuses a
 * redirected response served to a navigation from a service worker.
 *
 * Bump CACHE_VERSION when PRECACHE changes; activate() deletes every cache
 * that doesn't match it.
 */
const CACHE_VERSION = 'mnab-v1';
const OFFLINE_URL = '/offline';
const PRECACHE = [OFFLINE_URL, '/icons/icon-192.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).catch(() => caches.match(OFFLINE_URL)));
    return;
  }

  // The offline page's own icon: network first, precached copy if offline.
  if (PRECACHE.includes(url.pathname)) {
    event.respondWith(fetch(req).catch(() => caches.match(url.pathname)));
  }
  // Everything else (/api/*, shared JS/CSS, ...) is left to the network.
});

// ── Web Push ────────────────────────────────────────────────────────────
// Payloads come from api/_lib/push.js: { title, body, url }. iOS revokes
// push permission from a web app that receives a push without showing a
// notification, so a notification is shown for every push, even one whose
// payload can't be parsed.
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (err) {
    data = { body: event.data ? event.data.text() : '' };
  }
  event.waitUntil(
    self.registration.showNotification(data.title || 'MNAB', {
      body: data.body || '',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      data: { url: data.url || '/' },
    })
  );
});

// Tapping a notification opens its url (the pending-review list), reusing
// an open MNAB window when there is one.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || '/', self.location.origin).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if (new URL(client.url).origin !== self.location.origin) continue;
      try {
        const navigated = await client.navigate(target);
        return (navigated || client).focus();
      } catch (err) {
        break; // can't steer this window (e.g. not controlled yet): open a fresh one instead
      }
    }
    return self.clients.openWindow(target);
  })());
});
