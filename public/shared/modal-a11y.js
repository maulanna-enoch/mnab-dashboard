/* Small shared keyboard-accessibility helper for this app's `.open`-class
 * overlay/sheet convention (Reconcile, Add Payment, Undo reconciliation, the
 * generic alert/confirm dialog, the Add/Edit Transaction sheet, etc.). Wire
 * it into whatever function already adds/removes the `.open` class:
 *
 *   const overlay = document.getElementById('rc-overlay');
 *   overlay.classList.add('open');
 *   ModalA11y.open(overlay, { focus: someInputEl, onClose: closeReconcile });
 *   ...
 *   ModalA11y.close(overlay); // call from the same function that removes 'open'
 *
 * This is intentionally NOT a MutationObserver -- every overlay in this app
 * is already opened/closed through a small set of named functions, so
 * hooking those directly is simpler and matches the rest of the codebase's
 * style (see shared/keyboard-nav.js, shared/bulk-actions.js).
 *
 * Provides three things per overlay while it's registered "open":
 *
 *  1. Initial focus -- moves focus onto opts.focus if given and visible,
 *     else the first focusable element found inside the overlay, else the
 *     overlay itself (via a temporary tabindex="-1") as a last resort, so
 *     something always owns the keyboard the moment a sheet opens instead
 *     of leaving focus sitting on whatever background element triggered it
 *     (now hidden behind the overlay, but not blurred by any close*()
 *     function, and definitely not intended to keep receiving keystrokes).
 *
 *  2. A Tab/Shift+Tab focus trap -- keeps focus cycling within the
 *     overlay's own focusable elements instead of leaking into the page
 *     behind it, which stays fully in the DOM and unhidden (no build step,
 *     no component unmounting). Recomputed on every Tab press rather than
 *     once at open time, so it stays correct as a sheet's own content
 *     changes while it's open (e.g. Reconcile's compare/mismatch actions
 *     appearing after Calculate, or Undo's "Undo this reconciliation"
 *     button appearing once its lookup resolves).
 *
 *  3. Escape closes it -- calls opts.onClose() (defaulting to just removing
 *     the `.open` class) and restores focus to whatever had focus right
 *     before the overlay opened, so closing a sheet doesn't strand focus on
 *     a background element the user was never actually looking at. This is
 *     on top of, not instead of, any letter-key hotkeys a dialog already
 *     wires up itself (e.g. the D/C confirm hotkeys in accounts/index.html
 *     and shared/bulk-actions.js) -- Escape works whether or not a dialog
 *     opted into those.
 *
 * Listeners are attached to the overlay element itself with capture:true,
 * so they run before this page's own bubble-phase document keydown
 * listeners (which already separately back off via the existing
 * `document.querySelector('.open')` convention for single-letter hotkeys --
 * this doesn't replace that, it just makes sure Escape/Tab are handled here
 * first regardless of listener registration order).
 *
 * Multiple overlays can be registered "open" at once (e.g. a showConfirm()
 * dialog stacked on top of an open Reconcile sheet) -- each is tracked
 * independently, and since capture-phase listeners only fire for actual
 * ancestors of the focused element, only the overlay that currently
 * contains focus reacts to a given keypress. Closing the top one restores
 * focus back into whichever overlay was open underneath it.
 */
(function (global) {
  const FOCUSABLE_SELECTOR = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
  ].join(',');

  // overlayEl -> { onKeydown, previousFocus, addedTabindex }
  const registry = new Map();

  function focusableEls(overlayEl) {
    return Array.from(overlayEl.querySelectorAll(FOCUSABLE_SELECTOR))
      .filter((el) => el.offsetParent !== null); // skip hidden sub-panels, e.g. rc-add-form while rc-clear-form is the visible one
  }

  function open(overlayEl, opts) {
    opts = opts || {};
    close(overlayEl); // idempotent -- clear any stale listener from a prior open() on this same element

    const previousFocus = document.activeElement;

    const onKeydown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (typeof opts.onClose === 'function') opts.onClose();
        else overlayEl.classList.remove('open');
        return;
      }
      if (e.key !== 'Tab') return;
      const focusables = focusableEls(overlayEl);
      if (!focusables.length) { e.preventDefault(); return; }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    overlayEl.addEventListener('keydown', onKeydown, true);

    let addedTabindex = false;
    const focusTarget = (opts.focus && opts.focus.offsetParent !== null && opts.focus)
      || focusableEls(overlayEl)[0];
    if (focusTarget) {
      focusTarget.focus();
    } else {
      // Nothing focusable inside yet (e.g. a sheet still mid-fetch with no
      // rendered content) -- make the overlay itself a focus target so
      // Escape/Tab still work rather than stranding focus on whatever
      // triggered it. Only add tabindex if it doesn't already have one.
      if (!overlayEl.hasAttribute('tabindex')) {
        overlayEl.setAttribute('tabindex', '-1');
        addedTabindex = true;
      }
      overlayEl.focus();
    }

    registry.set(overlayEl, { onKeydown, previousFocus, addedTabindex });
  }

  function close(overlayEl) {
    const entry = registry.get(overlayEl);
    if (!entry) return;
    overlayEl.removeEventListener('keydown', entry.onKeydown, true);
    if (entry.addedTabindex) overlayEl.removeAttribute('tabindex');
    registry.delete(overlayEl);
    // Return focus to whatever opened this, if it's still on-screen --
    // otherwise leave focus alone rather than yanking it somewhere random.
    if (entry.previousFocus && document.contains(entry.previousFocus) && entry.previousFocus.offsetParent !== null) {
      entry.previousFocus.focus();
    }
  }

  global.ModalA11y = { open, close };
})(window);
