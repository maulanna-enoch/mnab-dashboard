/*
 * MNAB service worker.
 *
 * Its job right now is to make the dashboard installable as a Home Screen
 * web app (a prerequisite for Web Push on iOS) and to show a friendly
 * offline page instead of the browser's error screen. It is deliberately
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
