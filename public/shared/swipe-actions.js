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

  const TRASH_ICON = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>';
  const CHECK_ICON = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
  const UNDO_ICON = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5A5.5 5.5 0 0 1 20 14.5v0A5.5 5.5 0 0 1 14.5 20H11"/></svg>';

  // `isCleared` picks which icon/label the right-swipe reveals: a currently
  // Cleared transaction offers to mark it Uncleared, and vice versa.
  function rowHTML(rowNumber, rowClassName, innerHtml, isCleared) {
    const clearIcon = isCleared ? UNDO_ICON : CHECK_ICON;
    const clearLabel = isCleared ? 'Uncleared' : 'Clear';
    return `
      <div class="swx-wrap" data-row="${rowNumber}">
        <div class="swx-action swx-clear">${clearIcon}<span class="swx-action-label">${clearLabel}</span></div>
        <div class="swx-action swx-delete">${TRASH_ICON}<span class="swx-action-label">Delete</span></div>
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

  async function runAction(entry, fn, txn) {
    try {
      await fn(txn);
      // Successful actions are almost always followed by the caller
      // re-rendering the list (row deleted, or its cleared-state changed),
      // which replaces this DOM node entirely -- but settle without
      // animation regardless, in case the caller doesn't re-render.
      closeOpen(entry, false);
    } catch (err) {
      closeOpen(entry, true);
      if (typeof entry.options.onError === 'function') entry.options.onError(err);
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
      entry.suppressClick = false;
      return;
    }

    entry = { options, openWrap: null, openRow: null, drag: null, suppressClick: false };
    bound.set(containerEl, entry);

    containerEl.addEventListener('pointerdown', (e) => {
      const row = e.target.closest('.txn-row');
      if (!row || !containerEl.contains(row)) return;
      const wrap = row.closest('.swx-wrap');
      if (!wrap) return;

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
      const drag = entry.drag;
      if (!drag || drag.pointerId !== e.pointerId) return;
      entry.drag = null;
      if (drag.axis !== 'x') return; // plain tap, or a vertical scroll -- nothing to settle
      entry.suppressClick = true; // this gesture dragged; don't let the trailing click open the row
      let target = 0;
      if (drag.currentX <= -OPEN_THRESHOLD) target = -REVEAL;
      else if (drag.currentX >= OPEN_THRESHOLD) target = REVEAL;
      settle(entry, drag.row, target, true);
    }
    containerEl.addEventListener('pointerup', endDrag);
    containerEl.addEventListener('pointercancel', endDrag);

    // Capture phase so this runs before the page's own bubble-phase click
    // listener on `.txn-row` (the one that opens the edit sheet). That lets
    // us swallow: (a) the trailing click after a drag, and (b) the first tap
    // anywhere in the list while a row is swiped open -- which should just
    // close it, same as iOS, rather than also doing whatever a plain tap
    // would otherwise do.
    containerEl.addEventListener('click', (e) => {
      if (entry.suppressClick) {
        entry.suppressClick = false;
        e.preventDefault();
        e.stopPropagation();
        return;
      }

      const actionEl = e.target.closest('.swx-delete, .swx-clear');
      if (actionEl) {
        e.preventDefault();
        e.stopPropagation();
        const wrap = actionEl.closest('.swx-wrap');
        const rowNumber = parseInt(wrap.dataset.row, 10);
        const txn = entry.options.getRow(rowNumber);
        if (!txn) { closeOpen(entry, true); return; }
        if (actionEl.classList.contains('swx-delete')) {
          if (!confirm('Delete this transaction?')) return;
          runAction(entry, entry.options.onDelete, txn);
        } else {
          runAction(entry, entry.options.onToggleClear, txn);
        }
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
