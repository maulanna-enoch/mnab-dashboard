/* Shared swipe-to-reveal actions for transaction list rows, used by both the
 * Transactions page and the Account detail page's transaction list.
 *
 * Usage (mirrors shared/transaction-form.js's mount-once pattern):
 *
 *   // when building each row's HTML string, wrap the existing .txn-row
 *   // markup instead of emitting it bare:
 *   html += SwipeActions.rowHTML(t.rowNumber, `txn-row ${extraClass}`, innerHtml, isCleared);
 *
 *   // after `listEl.innerHTML = html`, (re-)attach behavior -- safe to call
 *   // on every render, same as the existing click-listener re-attach loops:
 *   SwipeActions.init(listEl, {
 *     getRow: (rowNumber) => transactions.find((t) => t.rowNumber === rowNumber),
 *     onDelete: async (txn) => { ...call /api/transactions-delete, refresh... },
 *     onToggleClear: async (txn) => { ...call /api/transactions-update, refresh... },
 *     onError: (err) => alert(err.message),
 *   });
 *
 * Swipe left reveals a delete button (trash icon, soft red, less than full
 * opacity); swipe right reveals a clear/unclear toggle button. Tapping the
 * delete button asks for confirmation before calling onDelete; tapping the
 * clear/unclear button calls onToggleClear directly. Similar to iOS's
 * swipe-to-delete: swiping only REVEALS the action, it doesn't fire it by
 * itself, so a fast full swipe still can't delete anything without an
 * explicit follow-up tap (and, for delete, the confirm dialog).
 *
 * Action buttons are fired on `pointerup` directly, NOT via a `click` event.
 * An earlier version fired on `click`, gated by a flag that a completed drag
 * set so the drag's own trailing click couldn't also open the edit sheet.
 * That works with a mouse (a browser still synthesizes `click` after a
 * mousedown+move+mouseup on the same element, which is also what Chromium
 * dispatches for Playwright's simulated mouse input -- so it looked fine
 * under headless testing) but NOT with real touch: touch UAs generally
 * don't synthesize a `click` at all after a drag past the browser's own
 * move threshold, so that flag was never getting consumed by a matching
 * click and sat "dirty" until the NEXT tap -- silently eating the very
 * first real tap on the revealed button and requiring a second one. Taps on
 * the action buttons are tracked with their own pointerdown/pointerup pair
 * instead, independent of whatever click semantics the browser/input device
 * happens to have.
 *
 * Uses Pointer Events (not touchstart/mousedown) so touch and mouse share
 * one code path -- same reasoning as the account-detail pull-to-refresh
 * gesture: Chromium dispatches pointer events for Playwright's simulated
 * mouse input too, so this is testable headlessly without a real touch
 * device.
 */
(function (global) {
  const REVEAL = 76; // px width of each action button, and how far a row slides
  const LOCK_THRESHOLD = 8; // px of movement before an axis (x vs y) is decided
  const OPEN_THRESHOLD = REVEAL / 2; // past this, release snaps open instead of closed
  const TAP_TOLERANCE = 12; // px a pointer can wander during an action-button tap and still count

  const TRASH_ICON = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>';
  const CHECK_ICON = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
  const UNDO_ICON = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5A5.5 5.5 0 0 1 20 14.5v0A5.5 5.5 0 0 1 14.5 20H11"/></svg>';
  const SPINNER_HTML = '<span class="swx-spinner" aria-hidden="true"></span>';

  // `isCleared` picks which icon/label the right-swipe reveals: a currently
  // Cleared transaction offers to mark it Uncleared, and vice versa.
  //
  // `isPayment` (optional, used by the account detail page for a credit
  // card's "Add Payment" legs -- see api/reconcile.js's Transfer/Payment ID
  // columns) swaps the left-swipe slot from "Delete" to "Undo" -- a payment
  // leg has a matching leg on another account that a plain single-row
  // delete would silently orphan, so the label/icon reflect that this
  // removes both sides, not just this row. handleActionTap below decides
  // the actual confirm wording/callback off the row's own `transfer` flag
  // (not this rendering flag), so the two always agree.
  function rowHTML(rowNumber, rowClassName, innerHtml, isCleared, isPayment) {
    const clearIcon = isCleared ? UNDO_ICON : CHECK_ICON;
    const clearLabel = isCleared ? 'Uncleared' : 'Clear';
    const removeIcon = isPayment ? UNDO_ICON : TRASH_ICON;
    const removeLabel = isPayment ? 'Undo' : 'Delete';
    return `
      <div class="swx-wrap" data-row="${rowNumber}">
        <div class="swx-action swx-clear">${clearIcon}<span class="swx-action-label">${clearLabel}</span></div>
        <div class="swx-action swx-delete">${removeIcon}<span class="swx-action-label">${removeLabel}</span></div>
        <div class="${rowClassName}">${innerHtml}</div>
      </div>
    `;
  }

  // One entry per container element (the list <div>), keyed by the element
  // itself so re-calling init() on every render (the list's innerHTML is
  // rebuilt from scratch each time) just refreshes callbacks/resets state
  // instead of stacking duplicate listeners.
  const bound = new WeakMap();

  function currentTranslateX(row) {
    const m = row.style.transform.match(/translateX\((-?\d+(?:\.\d+)?)px\)/);
    return m ? parseFloat(m[1]) : 0;
  }

  function settle(entry, row, x, animate) {
    row.style.transition = animate ? 'transform 0.2s ease' : 'none';
    row.style.transform = `translateX(${x}px)`;
    if (x === 0) {
      if (entry.openRow === row) { entry.openWrap = null; entry.openRow = null; }
    } else {
      entry.openWrap = row.closest('.swx-wrap');
      entry.openRow = row;
    }
  }

  function closeOpen(entry, animate) {
    if (entry.openRow) settle(entry, entry.openRow, 0, animate);
  }

  // Runs the actual delete/toggle-clear call, showing an in-button busy
  // state (spinner + "Deleting…"/"Clearing…"/"Unclearing…") the whole time
  // it's in flight, so the tap's effect is visible immediately even before
  // the network round-trip finishes. On success the caller almost always
  // re-renders the whole list right after (row deleted, or its cleared
  // state flipped), which replaces this DOM node entirely; on failure the
  // button's original icon/label is restored so it can be tried again.
  async function runBusyAction(entry, wrap, actionEl, fn, txn, busyLabel) {
    const originalHtml = actionEl.innerHTML;
    actionEl.innerHTML = `${SPINNER_HTML}<span class="swx-action-label">${busyLabel}</span>`;
    wrap.classList.add('swx-busy');
    try {
      await fn(txn);
      closeOpen(entry, false);
    } catch (err) {
      actionEl.innerHTML = originalHtml;
      wrap.classList.remove('swx-busy');
      closeOpen(entry, true);
      if (typeof entry.options.onError === 'function') entry.options.onError(err);
    }
  }

  function handleActionTap(entry, actionEl) {
    const wrap = actionEl.closest('.swx-wrap');
    if (!wrap || wrap.classList.contains('swx-busy')) return;
    const rowNumber = parseInt(wrap.dataset.row, 10);
    const txn = entry.options.getRow(rowNumber);
    if (!txn) { closeOpen(entry, true); return; }

    if (actionEl.classList.contains('swx-delete')) {
      // `txn.transfer` (from api/reconcile.js's actionDetail) is the source
      // of truth for whether this row is one leg of a card payment -- not
      // the button's own rendered icon/label -- so this always agrees with
      // rowHTML's `isPayment` rendering above. The caller's onDelete is
      // expected to branch on this same flag to call the right endpoint
      // (transactions-delete vs. reconcile's undo-payment).
      const isPayment = !!txn.transfer;
      const message = isPayment
        ? 'Undo this card payment? This removes BOTH the charge on the card and the matching entry on the paying account.'
        : 'Delete this transaction?';
      if (!confirm(message)) return;
      runBusyAction(entry, wrap, actionEl, entry.options.onDelete, txn, isPayment ? 'Undoing…' : 'Deleting…');
    } else {
      // The label already baked into the button by rowHTML() tells us which
      // direction this toggle goes -- "Uncleared" means it's currently
      // Cleared (tapping will uncleared it), "Clear" means the opposite.
      const wasCleared = actionEl.querySelector('.swx-action-label').textContent === 'Uncleared';
      runBusyAction(entry, wrap, actionEl, entry.options.onToggleClear, txn, wasCleared ? 'Unclearing…' : 'Clearing…');
    }
  }

  function init(containerEl, options) {
    let entry = bound.get(containerEl);
    if (entry) {
      // Re-render happened -- old rows are gone, so any "open" bookkeeping
      // pointed at now-detached nodes. Reset it; just swap in new callbacks.
      entry.options = options;
      entry.openWrap = null;
      entry.openRow = null;
      entry.drag = null;
      entry.actionPress = null;
      entry.suppressClick = false;
      return;
    }

    entry = { options, openWrap: null, openRow: null, drag: null, actionPress: null, suppressClick: false };
    bound.set(containerEl, entry);

    containerEl.addEventListener('pointerdown', (e) => {
      // Action-button taps are tracked independently of the row-drag state
      // below and fire on pointerup, not click -- see the file-level note
      // on why. `.swx-pressed` gives instant visual feedback that the touch
      // itself was recognized, before anything else (confirm dialog, busy
      // state, network) happens.
      const actionEl = e.target.closest('.swx-delete, .swx-clear');
      if (actionEl) {
        const actionWrap = actionEl.closest('.swx-wrap');
        if (actionWrap && actionWrap.classList.contains('swx-busy')) return;
        entry.actionPress = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, el: actionEl };
        actionEl.classList.add('swx-pressed');
        return;
      }

      const row = e.target.closest('.txn-row');
      if (!row || !containerEl.contains(row)) return;
      const wrap = row.closest('.swx-wrap');
      if (!wrap || wrap.classList.contains('swx-busy')) return;

      // Clear any stale "that gesture ended in a drag" bookkeeping from a
      // PREVIOUS gesture right as a new one starts, rather than waiting for
      // a click that may never come (see file-level note) -- so it can
      // never wrongly swallow this new gesture's own tap.
      entry.suppressClick = false;

      if (entry.openWrap && entry.openWrap !== wrap) {
        closeOpen(entry, true);
      }

      entry.drag = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        row,
        axis: null,
        baseX: currentTranslateX(row),
        currentX: currentTranslateX(row),
      };
    });

    containerEl.addEventListener('pointermove', (e) => {
      const press = entry.actionPress;
      if (press && press.pointerId === e.pointerId) {
        const dx = e.clientX - press.startX;
        const dy = e.clientY - press.startY;
        if (Math.hypot(dx, dy) > TAP_TOLERANCE) {
          press.el.classList.remove('swx-pressed');
          entry.actionPress = null;
        }
        return;
      }

      const drag = entry.drag;
      if (!drag || drag.pointerId !== e.pointerId) return;
      const dx = e.clientX - drag.startX;
      const dy = e.clientY - drag.startY;
      if (drag.axis === null) {
        if (Math.abs(dx) > LOCK_THRESHOLD && Math.abs(dx) > Math.abs(dy)) {
          drag.axis = 'x';
        } else if (Math.abs(dy) > LOCK_THRESHOLD) {
          drag.axis = 'y'; // vertical scroll -- let the page handle it
        } else {
          return;
        }
      }
      if (drag.axis !== 'x') return;
      if (e.cancelable) e.preventDefault();
      const x = Math.max(-REVEAL, Math.min(REVEAL, drag.baseX + dx));
      drag.row.style.transition = 'none';
      drag.row.style.transform = `translateX(${x}px)`;
      drag.currentX = x;
    });

    function endDrag(e) {
      const press = entry.actionPress;
      if (press && press.pointerId === e.pointerId) {
        entry.actionPress = null;
        press.el.classList.remove('swx-pressed');
        if (e.type === 'pointerup') handleActionTap(entry, press.el);
        return;
      }

      const drag = entry.drag;
      if (!drag || drag.pointerId !== e.pointerId) return;
      entry.drag = null;

      if (drag.axis !== 'x') {
        // Plain tap (no drag). If the row was already open, this tap should
        // just close it -- same as iOS -- rather than also opening the edit
        // sheet underneath. Settle it directly here rather than waiting on
        // a click, and mark suppressClick defensively in case a trailing
        // click still follows on this device/input.
        if (drag.baseX !== 0) {
          settle(entry, drag.row, 0, true);
          entry.suppressClick = true;
        }
        return;
      }

      let target = 0;
      if (drag.currentX <= -OPEN_THRESHOLD) target = -REVEAL;
      else if (drag.currentX >= OPEN_THRESHOLD) target = REVEAL;
      settle(entry, drag.row, target, true);
      entry.suppressClick = true;
    }
    containerEl.addEventListener('pointerup', endDrag);
    containerEl.addEventListener('pointercancel', endDrag);

    // Capture phase so this runs before the page's own bubble-phase click
    // listener on `.txn-row` (the one that opens the edit sheet).
    containerEl.addEventListener('click', (e) => {
      if (entry.suppressClick) {
        entry.suppressClick = false;
        e.preventDefault();
        e.stopPropagation();
        return;
      }

      if (e.target.closest('.swx-delete, .swx-clear')) {
        // Already handled on pointerup above -- swallow so a click firing
        // too (some browsers/input devices do) can't double-fire the
        // action or fall through to a row's click-to-edit handler.
        e.preventDefault();
        e.stopPropagation();
        return;
      }

      if (entry.openWrap) {
        e.preventDefault();
        e.stopPropagation();
        closeOpen(entry, true);
      }
    }, true);
  }

  global.SwipeActions = { init, rowHTML };
})(window);
