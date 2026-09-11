/* Shared multi-row selection + bulk-action bar (issue #78), used by the
 * Transactions page and the Account detail page's transaction list -- both
 * their mobile card list AND their wide-viewport data table (issue #65/#86)
 * views share ONE selection, since it's the same underlying data just
 * rendered two ways. Pairs with shared/bulk-actions.css.
 *
 * Usage (mirrors shared/swipe-actions.js and shared/transaction-form.js's
 * mount-once pattern):
 *
 *   BulkSelect.mount(document.getElementById('blk-root'), {
 *     getTxn: (rowNumber) => transactions.find((t) => t.rowNumber === rowNumber),
 *     formatAmount: formatIDR,
 *     entityLabel: 'transaction',       // singular, used to build "1 transaction selected"
 *     entityLabelPlural: 'transactions',
 *     actions: [
 *       { key: 'delete', label: 'Delete', danger: true, hotkey: 'Backspace', hotkeySymbol: '⌫' },
 *       { key: 'clear', label: 'Clear', hotkey: 'c' },
 *       { key: 'unclear', label: 'Unclear', hotkey: 'u' },
 *       { key: 'duplicate', label: 'Duplicate', hotkey: 'd' },
 *       { key: 'confirm', label: 'Confirm', hotkey: 'Enter', hotkeySymbol: '✓' },
 *       { key: 'changeDate', label: 'Change date', input: 'date', hotkey: 'h' },
 *       { key: 'changeBillingMonth', label: 'Change month', input: 'month', hotkey: 'm' },
 *     ],
 *     onAction: async (key, rowNumbers, inputValue) => { ...call the
 *       existing single-row endpoints in a loop, then refetch + re-render... },
 *     refresh: () => renderList(),   // cheap re-render of already-loaded
 *       // data, no refetch -- called right after a successful action clears
 *       // the selection, so checkboxes redraw unchecked immediately instead
 *       // of staying stuck checked (onAction's own refetch-driven render
 *       // upstream of that clear() still reflects the OLD, pre-clear
 *       // selection).
 *     onSelectionChange: (active) => { ...hide/show the page's own FAB... },
 *   });
 *
 * Then wire each row's own checkbox to BulkSelect.toggle(rowNumber) +
 * re-render, and call BulkSelect.update() after every render pass (so the
 * bar's count/net stay in sync with whatever's currently selected) and
 * BulkSelect.pruneToExisting(allCurrentRowNumbers) after every fresh fetch
 * from the server.
 *
 * -- Selection-persistence decision (issue #78 explicitly asks that this be
 * decided and documented, not left implicit) --
 * Selection is keyed by rowNumber and is NOT reset by a filter/sort change,
 * NOR by switching between the mobile card list and the wide-viewport table
 * (same underlying data, two views of it -- a row selected in one shows
 * selected in the other). It IS pruned automatically whenever the host
 * calls pruneToExisting() after a fresh server fetch, which drops any
 * rowNumber no longer present in the fresh data (e.g. deleted elsewhere).
 * It is also cleared automatically after every successful bulk action
 * (including a partial-failure one -- see runAction below) and by the
 * bar's own close (x) button. "Select all" (the table's header checkbox, or
 * the mobile list's "Select all" link) only ever adds/removes the rows
 * CURRENTLY VISIBLE under whatever filter is active -- it never reaches
 * rows a filter is currently hiding.
 *
 * -- Bulk delete row-number-shift hazard --
 * This module itself never talks to the network -- that's entirely the
 * host's onAction callback -- but every host implementation of the
 * 'delete' action MUST delete rows in DESCENDING rowNumber order, one
 * network call at a time (never in parallel). The delete endpoint removes a
 * sheet row by index (see api/transactions-delete.js's deleteDimension
 * call), which shifts every row below it up by one -- deleting in ascending
 * order (or in parallel) would silently delete the WRONG row for every
 * rowNumber captured before the loop started except the first.
 *
 * -- Keyboard bindings --
 * Each action above may carry a `hotkey` (a single letter, or the literal
 * string 'Backspace'/'Enter') and, for those two non-letter keys only, a
 * `hotkeySymbol` glyph -- renderActions() below underlines the hotkey
 * letter in the button's own label (e.g. Clear -> "<u>C</u>lear"), or for
 * Backspace/Enter appends the symbol instead, since there's no letter to
 * underline. The keydown listener registered near the bottom of this file
 * dispatches these ONLY once count() > 0 (i.e. once the bar is actually
 * showing) -- until then, every one of these keys still means whatever
 * each host page's OWN single-row keyboard shortcuts already say it means
 * (C toggles Cleared on the highlighted row, Backspace deletes it, Enter
 * opens it for edit). This module has no way to make that switch happen by
 * itself, though -- it doesn't know what a "highlighted row" even is, that
 * concept lives entirely in each host page's own keyboard-nav code. So
 * EVERY host page's document keydown handler must itself check
 * `BulkSelect.count() > 0` and back off (return, after still calling
 * e.preventDefault() so the key's browser default -- e.g. Backspace
 * navigating back -- doesn't fire either) for the handful of keys this
 * module reuses, before falling through to its own single-row behavior.
 * Row selection itself (toggling one row in or out of the selection while
 * cycling with Up/Down) is a per-host-page S-key binding for the same
 * reason -- this module only ever sees rowNumbers the host already handed
 * it via toggle()/selectAllVisible(), never a "currently highlighted" row.
 *
 * Bulk delete's own confirmation (see confirmDanger() below) replaces a
 * plain browser confirm() with a custom dialog matching the D-confirms/
 * C-cancels mnemonic convention the Transactions page's single-row delete
 * confirmation already established (issue #101), so the whole delete flow
 * stays keyboard-operable end to end, not just up to the confirmation step.
 */
(function (global) {
  const selected = new Set();
  let state = null; // set up on mount()

  function selectedRowNumbers() {
    return Array.from(selected);
  }
  function isSelected(rowNumber) {
    return selected.has(rowNumber);
  }
  function count() {
    return selected.size;
  }

  function toggle(rowNumber) {
    if (selected.has(rowNumber)) selected.delete(rowNumber);
    else selected.add(rowNumber);
    update();
  }

  // Adds/removes every rowNumber in `rowNumbers` (the CURRENTLY VISIBLE set
  // under whatever filter is active) -- never touches a selection outside
  // that list, so previously-selected rows a filter is now hiding are left
  // exactly as they were (see the file-level persistence decision above).
  function selectAllVisible(rowNumbers) {
    rowNumbers.forEach((n) => selected.add(n));
    update();
  }
  function deselectAllVisible(rowNumbers) {
    rowNumbers.forEach((n) => selected.delete(n));
    update();
  }
  function isAllVisibleSelected(rowNumbers) {
    return rowNumbers.length > 0 && rowNumbers.every((n) => selected.has(n));
  }

  function clear() {
    selected.clear();
    update();
  }

  // Drops any selected rowNumber not present in `existingRowNumbers` --
  // call after every fresh server fetch (a row may have been deleted
  // elsewhere, e.g. a single-row swipe-delete on another device).
  function pruneToExisting(existingRowNumbers) {
    const keep = new Set(existingRowNumbers);
    Array.from(selected).forEach((n) => { if (!keep.has(n)) selected.delete(n); });
    update();
  }

  function closeInputRow() {
    state.inputRow.style.display = 'none';
    state.actionsRow.style.display = '';
    state.pendingAction = null;
  }

  function setBusy(busy) {
    state.busy = busy;
    state.actionsRow.querySelectorAll('button').forEach((b) => { b.disabled = busy; });
    state.closeBtn.disabled = busy;
    state.inputApply.disabled = busy;
    state.inputCancel.disabled = busy;
  }

  // Underlines `letter`'s first case-insensitive occurrence in `label`
  // (e.g. underlineLetter('Clear', 'c') -> "<u>C</u>lear") -- shared by
  // both the action buttons (renderActions below) and the delete
  // confirmation dialog's own Yes button. Falls back to a plain label when
  // there's no letter, or it isn't actually present in the label.
  function underlineLetter(label, letter) {
    const idx = letter ? label.toLowerCase().indexOf(letter.toLowerCase()) : -1;
    if (idx === -1) return label;
    return label.slice(0, idx) + '<u>' + label[idx] + '</u>' + label.slice(idx + 1);
  }

  // Replaces the plain browser confirm() this used to call directly for a
  // "danger" action with a custom dialog that keeps the D-confirms/
  // C-cancels mnemonic convention working (see the file-level comment on
  // keyboard bindings above) -- Enter/Escape work too as the usual dialog
  // fallbacks. Returns a Promise<boolean>.
  function confirmDanger(message, verb) {
    return new Promise((resolve) => {
      state.confirmMessage.textContent = message;
      state.confirmYesBtn.innerHTML = underlineLetter(verb || 'Delete', 'd');
      state.confirmOverlay.classList.add('open');

      const close = (result) => {
        state.confirmOverlay.classList.remove('open');
        state.confirmYesBtn.removeEventListener('click', onYes);
        state.confirmCancelBtn.removeEventListener('click', onCancel);
        document.removeEventListener('keydown', onKeydown);
        resolve(result);
      };
      const onYes = () => close(true);
      const onCancel = () => close(false);
      state.confirmYesBtn.addEventListener('click', onYes);
      state.confirmCancelBtn.addEventListener('click', onCancel);

      // D confirms, C cancels -- matches the underlined letters on the two
      // buttons and the Transactions page's own single-row delete dialog
      // (issue #101). stopImmediatePropagation for the same reason that
      // dialog needs it: closing this (removing "open") happens
      // synchronously in this same dispatch, so without it the bulk-action
      // hotkey listener further down this file (registered on the same
      // document, and blind to an overlay that's already closed by the
      // time it runs) would go on to act on this *same* keypress too --
      // e.g. "D" would also fire bulk Duplicate immediately after
      // confirming the delete.
      const onKeydown = (e) => {
        if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
        const k = e.key.toLowerCase();
        if (k !== 'd' && k !== 'c' && e.key !== 'Enter' && e.key !== 'Escape') return;
        e.preventDefault();
        e.stopImmediatePropagation();
        close(k === 'd' || e.key === 'Enter');
      };
      document.addEventListener('keydown', onKeydown);
    });
  }

  async function runAction(key, inputValue) {
    const rowNumbers = selectedRowNumbers();
    if (!rowNumbers.length) return;
    const action = state.options.actions.find((a) => a.key === key);
    if (action && action.danger) {
      const label = rowNumbers.length === 1 ? state.options.entityLabel : state.options.entityLabelPlural;
      const confirmed = await confirmDanger(`${action.confirmVerb || 'Delete'} ${rowNumbers.length} ${label}? This can't be undone.`, action.confirmVerb);
      if (!confirmed) return;
    }
    setBusy(true);
    try {
      await state.options.onAction(key, rowNumbers, inputValue);
      // Cleared unconditionally on success, including a "duplicate" (the
      // originals are unchanged, but starting the next action from a clean
      // slate is simpler and less surprising than guessing which rows --
      // originals, new copies, both -- the user would want to stay selected).
      selected.clear();
      closeInputRow();
      // onAction's own refresh (re-fetching + re-rendering) already ran
      // BEFORE the clear() above -- its checkboxes were drawn against the
      // selection as it stood mid-action, so every one of them still shows
      // checked even though nothing is selected anymore. `refresh` is a
      // second, cheap, no-refetch re-render (the host's existing render
      // function, called with already-in-memory data) purely to redraw
      // checkboxes/select-all state against the now-empty selection --
      // without it they'd stay stuck checked until some unrelated
      // interaction happened to re-render the list.
      if (typeof state.options.refresh === 'function') state.options.refresh();
    } catch (err) {
      alert(err.message);
    } finally {
      setBusy(false);
      update();
    }
  }

  function openInputRow(action) {
    state.pendingAction = action.key;
    state.inputLabel.textContent = action.label + ':';
    state.input.type = action.input; // 'date' or 'month'
    // Defaults to today/this-month, purely as a convenient starting point --
    // both fields are freely editable before Apply.
    state.input.value = action.input === 'date'
      ? global.TransactionForm.todayISO()
      : global.TransactionForm.todayISO().slice(0, 7);
    state.actionsRow.style.display = 'none';
    state.inputRow.style.display = 'flex';
    state.input.focus();
  }

  // A button's hotkey is shown as an underlined letter within its own
  // label (e.g. "<u>C</u>lear") -- except Backspace/Enter, which aren't
  // letters in the word at all, so those get `hotkeySymbol` appended
  // instead (e.g. "Delete ⌫"). See this file's header comment.
  function actionButtonLabel(action) {
    if (action.hotkeySymbol) {
      return `${action.label} <span class="blk-hotkey-symbol">${action.hotkeySymbol}</span>`;
    }
    return underlineLetter(action.label, action.hotkey);
  }

  function renderActions() {
    state.actionsRow.innerHTML = '';
    state.options.actions.forEach((action) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'blk-action-btn' + (action.danger ? ' danger' : '');
      btn.innerHTML = actionButtonLabel(action);
      btn.addEventListener('click', () => {
        if (action.input) openInputRow(action);
        else runAction(action.key, null);
      });
      state.actionsRow.appendChild(btn);
    });
  }

  function update() {
    if (!state) return;
    const n = count();
    const active = n > 0;
    state.bar.classList.toggle('blk-active', active);
    if (typeof state.options.onSelectionChange === 'function' && state.lastActive !== active) {
      state.lastActive = active;
      state.options.onSelectionChange(active);
    }
    if (!active) return;

    const label = n === 1 ? state.options.entityLabel : state.options.entityLabelPlural;
    state.count.textContent = `${n} ${label} selected`;

    // Net total across every selected row -- expenses and income negate
    // each other (issue #78) rather than summing absolute values, so a
    // selection with one +100k income and one -40k expense reads as a net
    // +60k, not 140k.
    let net = 0;
    selectedRowNumbers().forEach((rowNumber) => {
      const txn = state.options.getTxn(rowNumber);
      if (!txn) return;
      const amount = Number(txn.amount) || 0;
      net += txn.type === 'Income' ? amount : -amount;
    });
    const sign = net >= 0 ? '+' : '-';
    state.net.textContent = sign + state.options.formatAmount(Math.abs(net));
    state.net.classList.toggle('positive', net >= 0);
    state.net.classList.toggle('negative', net < 0);
  }

  function mount(rootEl, options) {
    options = options || {};
    rootEl.innerHTML = `
      <div class="blk-bar" id="blk-bar">
        <div class="blk-bar-inner">
          <div class="blk-top-row">
            <button type="button" class="blk-close" id="blk-close" title="Clear selection">&times;</button>
            <div class="blk-summary">
              <span class="blk-count" id="blk-count"></span>
              <span class="blk-net" id="blk-net"></span>
            </div>
          </div>
          <div class="blk-actions" id="blk-actions"></div>
          <div class="blk-input-row" id="blk-input-row" style="display:none;">
            <span class="blk-input-label" id="blk-input-label"></span>
            <input class="blk-input" id="blk-input" />
            <button type="button" class="blk-input-apply" id="blk-input-apply">Apply</button>
            <button type="button" class="blk-input-cancel" id="blk-input-cancel">Cancel</button>
          </div>
        </div>
      </div>
      <div class="blk-confirm-overlay" id="blk-confirm-overlay">
        <div class="blk-confirm-sheet">
          <p class="blk-confirm-message" id="blk-confirm-message"></p>
          <div class="blk-confirm-actions">
            <button type="button" class="blk-confirm-btn blk-confirm-cancel" id="blk-confirm-cancel-btn"><u>C</u>ancel</button>
            <button type="button" class="blk-confirm-btn blk-confirm-yes" id="blk-confirm-yes-btn">Delete</button>
          </div>
        </div>
      </div>
    `;

    state = {
      options,
      busy: false,
      pendingAction: null,
      lastActive: false,
      bar: rootEl.querySelector('#blk-bar'),
      closeBtn: rootEl.querySelector('#blk-close'),
      count: rootEl.querySelector('#blk-count'),
      net: rootEl.querySelector('#blk-net'),
      actionsRow: rootEl.querySelector('#blk-actions'),
      inputRow: rootEl.querySelector('#blk-input-row'),
      inputLabel: rootEl.querySelector('#blk-input-label'),
      input: rootEl.querySelector('#blk-input'),
      inputApply: rootEl.querySelector('#blk-input-apply'),
      inputCancel: rootEl.querySelector('#blk-input-cancel'),
      confirmOverlay: rootEl.querySelector('#blk-confirm-overlay'),
      confirmMessage: rootEl.querySelector('#blk-confirm-message'),
      confirmYesBtn: rootEl.querySelector('#blk-confirm-yes-btn'),
      confirmCancelBtn: rootEl.querySelector('#blk-confirm-cancel-btn'),
    };

    renderActions();

    state.closeBtn.addEventListener('click', () => clear());
    state.inputCancel.addEventListener('click', () => closeInputRow());
    state.inputApply.addEventListener('click', () => {
      if (!state.input.value) return;
      runAction(state.pendingAction, state.input.value);
    });
  }

  function isRealTextField(t) {
    const tag = t && t.tagName;
    return (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable)) && t.offsetParent !== null;
  }

  function hotkeyMatches(hotkey, e) {
    if (!hotkey) return false;
    if (hotkey === 'Backspace' || hotkey === 'Enter') return e.key === hotkey;
    return e.key.length === 1 && e.key.toLowerCase() === hotkey.toLowerCase();
  }

  // Registered once, at module load -- mount() only ever runs once per
  // page, so there's no risk of this piling up duplicate listeners. Only
  // acts once count() > 0 (see the file-level "Keyboard bindings" comment
  // above for why every host page's own keydown handler has to cooperate
  // with that same condition for C/Backspace/Enter). Arrow Up/Down and the
  // row-select key (S) are each host page's own responsibility, not this
  // module's -- they're independent of selection count and this module has
  // no notion of "the currently highlighted row" to toggle in the first
  // place.
  document.addEventListener('keydown', (e) => {
    if (!state || count() === 0) return;
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    if (isRealTextField(e.target)) return; // the bar's own date/month input, a filter box, etc.
    if (document.querySelector('.open')) return; // a real modal -- including our own confirm dialog above -- owns the keyboard
    if (state.busy) return;

    const action = state.options.actions.find((a) => hotkeyMatches(a.hotkey, e));
    if (!action) return;
    e.preventDefault();
    if (action.input) openInputRow(action);
    else runAction(action.key, null);
  });

  global.BulkSelect = {
    mount,
    toggle,
    isSelected,
    selectAllVisible,
    deselectAllVisible,
    isAllVisibleSelected,
    clear,
    count,
    selectedRowNumbers,
    pruneToExisting,
    update,
  };
})(window);
