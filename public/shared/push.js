/*
 * shared/push.js: the "Notifications" bell and sheet. Lets this device turn
 * Web Push on or off and send itself a test.
 *
 *   PushToggle.mount(buttonEl);
 *
 * Builds its own sheet (prefix `psh-`, `.open`-class overlay convention, so
 * shared/keyboard-nav.js stays quiet while it's up) and uses ModalA11y for
 * focus/Escape when the page has loaded shared/modal-a11y.js.
 *
 * States the sheet can be in:
 *   needs-install  iPhone/iPad Safari tab: iOS only allows Web Push from the
 *                  Home Screen icon, so explain that instead.
 *   unsupported    browser has no Push API at all.
 *   blocked        the user said no to the permission prompt earlier.
 *   server-off     VAPID keys aren't set in Vercel yet.
 *   off / on       the normal toggle.
 *
 * Notification.requestPermission() must run straight from the tap (Safari
 * drops the prompt otherwise), so /api/push?action=config is fetched when
 * the sheet opens, not after the tap.
 */
(function (global) {
  'use strict';

  var API = '/api/push';
  var config = null;
  var els = {};
  var busy = false;

  function isIOS() {
    var ua = global.navigator.userAgent || '';
    return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && global.navigator.maxTouchPoints > 1);
  }

  function isStandalone() {
    return global.MNABPwa ? global.MNABPwa.isStandalone() : false;
  }

  function hasPushApi() {
    return 'serviceWorker' in global.navigator && 'PushManager' in global && 'Notification' in global;
  }

  function deviceLabel() {
    var ua = global.navigator.userAgent || '';
    var kind = /iPad/.test(ua) || (/Macintosh/.test(ua) && global.navigator.maxTouchPoints > 1) ? 'iPad'
      : /iPhone|iPod/.test(ua) ? 'iPhone'
      : /Android/.test(ua) ? 'Android'
      : /Macintosh/.test(ua) ? 'Mac'
      : /Windows/.test(ua) ? 'Windows' : 'Browser';
    return kind + (isStandalone() ? ' (Home Screen)' : ' (browser tab)');
  }

  function urlBase64ToUint8Array(base64) {
    var padding = '='.repeat((4 - (base64.length % 4)) % 4);
    var raw = global.atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  function post(body) {
    return global.fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
        return data;
      });
    });
  }

  function loadConfig() {
    if (config) return Promise.resolve(config);
    return global.fetch(API + '?action=config')
      .then(function (res) { return res.json(); })
      .then(function (data) { config = data; return data; });
  }

  function currentSubscription() {
    return global.navigator.serviceWorker.ready.then(function (reg) {
      return reg.pushManager.getSubscription();
    });
  }

  function getState() {
    if (!hasPushApi()) return Promise.resolve(isIOS() && !isStandalone() ? 'needs-install' : 'unsupported');
    if (global.Notification.permission === 'denied') return Promise.resolve('blocked');
    return loadConfig().then(function (cfg) {
      if (!cfg || !cfg.enabled || !cfg.publicKey) return 'server-off';
      return currentSubscription().then(function (sub) { return sub ? 'on' : 'off'; });
    });
  }

  var COPY = {
    'needs-install': 'On iPhone, notifications only work in the Home Screen app. In Safari, tap Share → Add to Home Screen, then open MNAB from its icon and come back here.',
    'unsupported': 'This browser can’t receive push notifications.',
    'blocked': 'Notifications are blocked for MNAB. Turn them on in Settings → Notifications → MNAB, then reopen this.',
    'server-off': 'Push isn’t set up on the server yet: VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY are missing in Vercel.',
    'off': 'Get a notification on this device whenever a new bank transaction is imported from email.',
    'on': 'Notifications are on for this device. New bank transactions imported from email will show up here.',
  };

  function render(state, note) {
    els.text.textContent = COPY[state] || '';
    els.note.textContent = note || '';
    els.primary.hidden = !(state === 'off' || state === 'on');
    els.primary.textContent = state === 'on' ? 'Turn off' : 'Turn on notifications';
    els.primary.classList.toggle('psh-btn-secondary', state === 'on');
    els.test.hidden = state !== 'on';
    els.button.classList.toggle('psh-on', state === 'on');
    els.button.setAttribute('aria-label', state === 'on' ? 'Notifications: on' : 'Notifications');
    els.state = state;
  }

  function refresh(note) {
    return getState().then(function (state) { render(state, note); return state; })
      .catch(function (err) { render('unsupported', 'Couldn’t check notification status: ' + err.message); });
  }

  // Not `disabled`: disabling the focused button would drop focus out of the
  // sheet, and ModalA11y's Escape/Tab handling only sees keys inside it.
  // The `busy` flag is what actually blocks a double tap.
  function setBusy(on) {
    busy = on;
    [els.primary, els.test].forEach(function (b) {
      b.setAttribute('aria-disabled', on ? 'true' : 'false');
      b.classList.toggle('psh-busy', on);
    });
  }

  function turnOn() {
    // First await in this chain is the permission prompt itself, so it still
    // counts as part of the tap.
    return global.Notification.requestPermission().then(function (perm) {
      if (perm !== 'granted') return refresh(perm === 'denied' ? '' : 'Permission wasn’t granted.');
      return global.navigator.serviceWorker.ready.then(function (reg) {
        return reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(config.publicKey),
        });
      }).then(function (sub) {
        return post({ action: 'subscribe', subscription: sub.toJSON(), device: deviceLabel() })
          .catch(function (err) {
            // Don't leave a browser-side subscription the server doesn't know about.
            return sub.unsubscribe().then(function () { throw err; });
          });
      }).then(function () { return refresh('Done. Tap “Send test” to check it works.'); });
    });
  }

  function turnOff() {
    return currentSubscription().then(function (sub) {
      if (!sub) return null;
      var endpoint = sub.endpoint;
      return sub.unsubscribe().then(function () { return post({ action: 'unsubscribe', endpoint: endpoint }); });
    }).then(function () { return refresh('Notifications are off for this device.'); });
  }

  function sendTest() {
    return currentSubscription().then(function (sub) {
      if (!sub) return refresh();
      return post({ action: 'test', endpoint: sub.endpoint })
        .then(function () { els.note.textContent = 'Test sent. It should arrive in a few seconds.'; });
    });
  }

  function run(fn) {
    if (busy) return;
    setBusy(true);
    els.note.textContent = '';
    fn().catch(function (err) { els.note.textContent = 'Something went wrong: ' + err.message; })
      .then(function () { setBusy(false); });
  }

  function open() {
    els.overlay.classList.add('open');
    if (global.ModalA11y) global.ModalA11y.open(els.overlay, { focus: els.close, onClose: close });
    els.text.textContent = 'Checking…';
    els.note.textContent = '';
    els.primary.hidden = true;
    els.test.hidden = true;
    refresh();
  }

  function close() {
    if (global.ModalA11y) global.ModalA11y.close(els.overlay);
    els.overlay.classList.remove('open');
  }

  function build() {
    var overlay = document.createElement('div');
    overlay.className = 'psh-overlay';
    overlay.innerHTML =
      '<div class="psh-sheet" role="dialog" aria-modal="true" aria-labelledby="psh-title">' +
        '<div class="psh-header">' +
          '<div class="psh-title" id="psh-title">Notifications</div>' +
          '<button type="button" class="psh-close" aria-label="Close">×</button>' +
        '</div>' +
        '<p class="psh-text"></p>' +
        '<button type="button" class="psh-btn psh-primary"></button>' +
        '<button type="button" class="psh-btn psh-btn-secondary psh-test">Send test</button>' +
        '<p class="psh-note" aria-live="polite"></p>' +
      '</div>';
    document.body.appendChild(overlay);
    els.overlay = overlay;
    els.close = overlay.querySelector('.psh-close');
    els.text = overlay.querySelector('.psh-text');
    els.primary = overlay.querySelector('.psh-primary');
    els.test = overlay.querySelector('.psh-test');
    els.note = overlay.querySelector('.psh-note');

    els.close.addEventListener('click', close);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
    els.primary.addEventListener('click', function () { run(els.state === 'on' ? turnOff : turnOn); });
    els.test.addEventListener('click', function () { run(sendTest); });
  }

  // If this device is subscribed, re-send the subscription once per page
  // load. Cheap, and it puts the row back if it was cleared on the server
  // (e.g. someone tidied the PushSubscriptions tab).
  function resync() {
    getState().then(function (state) {
      if (els.button) els.button.classList.toggle('psh-on', state === 'on');
      if (state !== 'on') return null;
      return currentSubscription().then(function (sub) {
        if (sub) return post({ action: 'subscribe', subscription: sub.toJSON(), device: deviceLabel() });
        return null;
      });
    }).catch(function () { /* best effort */ });
  }

  function mount(buttonEl) {
    if (!buttonEl) return;
    els.button = buttonEl;
    build();
    buttonEl.addEventListener('click', open);
    resync();
  }

  global.PushToggle = { mount: mount, _getState: getState };
})(window);
