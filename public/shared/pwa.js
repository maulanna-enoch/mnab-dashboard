/*
 * shared/pwa.js: registers the service worker (/sw.js) so MNAB can be
 * installed as a Home Screen web app. Included with a plain <script> tag
 * in every page's <head>, next to the manifest link and the iOS meta tags.
 * No mount() call, no markup.
 *
 * Exposes window.MNABPwa.isStandalone() so later features (the "Turn on
 * notifications" button, for one) can tell whether the page was opened
 * from the Home Screen icon, which is the only place iOS allows Web Push.
 */
(function (global) {
  'use strict';

  function isStandalone() {
    return (global.matchMedia && global.matchMedia('(display-mode: standalone)').matches) ||
      global.navigator.standalone === true;
  }

  global.MNABPwa = { isStandalone: isStandalone };

  if (!('serviceWorker' in global.navigator)) return;

  global.addEventListener('load', function () {
    global.navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(function (err) {
      // Not fatal: the app works exactly as before without it.
      console.warn('[MNAB] service worker registration failed', err);
    });
  });
})(window);
