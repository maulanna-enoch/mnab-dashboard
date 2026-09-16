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
 *
 * Also skipped for whichever of these letters the bulk action bar has
 * reclaimed while rows are multi-selected -- today just H, which the bar
 * binds to "Change date". See the BulkSelect.ownsKey() call in mount().
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

      // Multi-select mode reclaims some of these letters. The bulk action
      // bar (shared/bulk-actions.js) binds "Change date" to H, which
      // collides with Home here -- and since both listeners live on
      // `document`, its preventDefault() doesn't stop this one, so pressing
      // H with rows selected used to open the date input AND navigate away,
      // losing the selection. Ask the bar which keys are currently its own
      // rather than hard-coding H: that keeps this file ignorant of the
      // bar's hotkey list, and covers any hotkey added there later. Only
      // the colliding key yields -- B/T/A still navigate while rows are
      // selected, and H is Home again the moment nothing is selected.
      // BulkSelect is absent on pages that don't load bulk-actions.js
      // (home, bills, payees), hence the guard.
      if (global.BulkSelect && global.BulkSelect.ownsKey(e)) return;

      if (normalizePath(window.location.pathname) === normalizePath(href)) return; // already there

      e.preventDefault();
      window.location.href = href;
    });
  }

  global.KeyboardNav = { mount };
})(window);
