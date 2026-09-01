/* Global hardware-keyboard page-navigation shortcuts, mounted once per page:
 *
 *   KeyboardNav.mount();
 *
 * Pressing H/B/T/A jumps straight to Home/Bills/Transactions/Accounts from
 * anywhere in the app -- the same four destinations as shared/bottom-nav.js's
 * tabs. This is a no-build static app (full page load per nav, no
 * client-side router -- see bottom-nav.js's own file comment), so "jumping"
 * here just means setting window.location.href, same as clicking a tab.
 *
 * Same guard rails as the "N" add-transaction shortcut in
 * shared/transaction-form.js (see issue #60): skipped while focus is in a
 * text field, while any modifier key is held, and on a repeated keydown
 * (key held down) -- so this can't misfire while typing "b" into a Payee
 * field, for instance. Also skipped while any overlay/sheet using the
 * shared `.open` convention (Add/Edit transaction, reconcile, payment,
 * confirm dialogs, etc.) is open, so a hotkey press mid-form can't
 * navigate away and silently drop unsaved input.
 */
(function (global) {
  const ROUTES = { h: '/', b: '/installments', t: '/transactions', a: '/accounts' };

  // Trailing-slash-insensitive compare against the current page -- pressing
  // the hotkey for the page you're already on is a no-op instead of a
  // pointless reload/flicker.
  function normalizePath(p) {
    return p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p;
  }

  function mount() {
    document.addEventListener('keydown', (e) => {
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      const href = ROUTES[e.key.toLowerCase()];
      if (!href) return;

      const t = e.target;
      const tag = t && t.tagName;
      // offsetParent === null also catches a field that's still focused but
      // now hidden -- e.g. a sheet's own input keeps focus after the sheet
      // is closed (closeReconcile()/closePayCard()/etc. don't blur it), and
      // without this check that leftover focus would silently swallow every
      // hotkey until the user clicks elsewhere.
      const isTextField = (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable)) && t.offsetParent !== null;
      if (isTextField) return;

      if (document.querySelector('.open')) return; // a sheet/overlay/modal owns the keyboard right now

      if (normalizePath(window.location.pathname) === normalizePath(href)) return; // already there

      e.preventDefault();
      window.location.href = href;
    });
  }

  global.KeyboardNav = { mount };
})(window);
