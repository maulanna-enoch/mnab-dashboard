/* Shared "Add/Edit transaction" form, used by both the home page and the
 * Transactions page. Mount it once per page:
 *
 *   TransactionForm.mount(document.getElementById('txf-root'), {
 *     supportEditDelete: false,      // true on the Transactions page
 *     onSaved: (txn, isEdit) => {},  // called after a successful save
 *     onDeleted: (rowNumber) => {},  // called after a successful delete
 *   });
 *
 * Then open it with TransactionForm.open() (blank/add) or
 * TransactionForm.open(txn) (edit, when supportEditDelete is true), and
 * close it with TransactionForm.close().
 *
 * This is the ONE place the form's markup/behaviour lives -- editing this
 * file (and transaction-form.css) changes both pages at once. Every id/class
 * it creates is prefixed txf- so it can't collide with a host page's own
 * styles or ids.
 */
(function (global) {
  // Shared-secret guard for the write endpoints (see issue #30 / api/transactions-add.js).
  // This is NOT a real secret -- it ships in this public JS file to every
  // browser that loads the app, so anyone who inspects the page can read it.
  // It exists only so the API isn't wide open to blind/opportunistic traffic
  // (e.g. a scanner hitting the URL by chance); it does not stop someone who
  // actually looks at this file. Must match MNAB_WRITE_TOKEN in Vercel's
  // project env vars -- if you rotate one, rotate both and redeploy.
  const WRITE_TOKEN = '8b10b1f409aa31c1f25bf2890f69480a31e2cbe5639b0f8e';

  const FORM_HTML = `
    <button class="txf-fab" id="txf-fab">+</button>
    <div class="txf-toast" id="txf-toast">Saved</div>

    <div class="txf-overlay" id="txf-overlay">
      <div class="txf-sheet">
        <div class="txf-sheet-header">
          <div class="txf-sheet-title" id="txf-sheet-title">Add transaction</div>
          <div class="txf-sheet-close" id="txf-sheet-close">&times;</div>
        </div>

        <div class="txf-toggle-row" id="txf-type-toggle">
          <button class="txf-toggle-btn" data-type="Expense">Expense</button>
          <button class="txf-toggle-btn" data-type="Income">Income</button>
        </div>

        <label class="txf-amount-block" for="txf-f-amount">
          <div class="txf-amount-label">Amount</div>
          <div class="txf-amount-row">
            <span class="txf-amount-currency" id="txf-amount-currency">Rp</span>
            <input id="txf-f-amount" class="txf-amount-input" type="text" inputmode="numeric" placeholder="0" />
          </div>
          <div class="txf-amount-rule"></div>
        </label>

        <label class="txf-field-label">Payee</label>
        <div class="txf-payee-row">
          <input id="txf-f-payee" class="txf-field txf-payee-input" type="text" placeholder="e.g. Sushi Hiro, Plaza Indonesia" list="txf-payee-list" autocomplete="off" />
          <div class="txf-loc-control">
            <button type="button" class="txf-loc-toggle" id="txf-loc-toggle" title="Save this location for this payee" style="display:none;">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-7-6.1-7-11.5A7 7 0 0 1 19 9.5C19 14.9 12 21 12 21Z"/><circle cx="12" cy="9.5" r="2.3"/></svg>
            </button>
            <div class="txf-loc-dist" id="txf-loc-dist"></div>
          </div>
        </div>
        <datalist id="txf-payee-list"></datalist>
        <div class="txf-loc-hint" id="txf-loc-hint" style="display:none;"></div>

        <label class="txf-field-label">Account (SOF)</label>
        <select id="txf-f-sof" class="txf-field"></select>

        <div class="txf-row-2">
          <div>
            <label class="txf-field-label">Date</label>
            <input id="txf-f-date" class="txf-field" type="date" />
          </div>
          <div>
            <label class="txf-field-label">Billing month</label>
            <input id="txf-f-month" class="txf-field" type="month" />
          </div>
        </div>

        <label class="txf-field-label">Notes (optional)</label>
        <input id="txf-f-notes" class="txf-field" type="text" placeholder="e.g. Aolion Knight Joycon" />

        <div class="txf-toggle-row" id="txf-status-toggle">
          <button class="txf-toggle-btn" data-status="Cleared">Cleared</button>
          <button class="txf-toggle-btn" data-status="Uncleared">Uncleared</button>
        </div>

        <div id="txf-form-error" class="txf-error" style="display:none; margin-bottom: 8px;"></div>
        <button class="txf-save-btn" id="txf-save-btn">Save</button>
        <div class="txf-delete-link" id="txf-delete-link">Delete transaction</div>
      </div>
    </div>
  `;

  // Local-date "YYYY-MM-DD", not UTC -- toISOString() converts to UTC first,
  // which silently shifts the date back a day for any positive UTC offset
  // (e.g. WIB/UTC+7). Every date string in this module goes through this
  // instead of toISOString().
  function todayISO() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function monthValue(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  }

  // Billing-month pre-fill: day 1-12 of the month -> that same month, day
  // 13+ -> the next month. Same heuristic used in Reconcile.gs and the
  // reconciliation dialog. Still fully editable -- this is a starting
  // guess -- and a "touched" flag stops it from overwriting a manual edit
  // once you've changed it yourself.
  function guessBillingMonth(dateStr) {
    const d = new Date(dateStr + 'T00:00:00');
    // Snap to day 1 before incrementing the month -- otherwise a date like
    // Aug 31 rolls into October (September only has 30 days), overshooting
    // the guess by an extra month.
    if (d.getDate() > 12) {
      d.setDate(1);
      d.setMonth(d.getMonth() + 1);
    }
    return monthValue(d);
  }

  function digitsOnly(str) {
    return (str || '').replace(/[^\d]/g, '');
  }
  function formatAmountDisplay(digits) {
    return digits.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  }

  // Great-circle distance in km -- used only to rank the Payee datalist by
  // proximity (see issue #52), not for anything precision-sensitive.
  function haversineKm(a, b) {
    const R = 6371;
    const toRad = (v) => (v * Math.PI) / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLon = toRad(b.lon - a.lon);
    const lat1 = toRad(a.lat);
    const lat2 = toRad(b.lat);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  let state = null; // set up on mount()
  let payeeCache = []; // last-fetched [{name, lat, lon}], re-sorted as location becomes available
  let locRequestToken = 0; // invalidates a stale getCurrentPosition callback after the sheet is closed/reopened

  function setToggle(groupId, attr, value) {
    document.querySelectorAll(`#${groupId} .txf-toggle-btn`).forEach((b) => {
      b.classList.toggle('active', b.dataset[attr] === value);
    });
  }
  function getToggle(groupId, attr) {
    const active = document.querySelector(`#${groupId} .txf-toggle-btn.active`);
    return active ? active.dataset[attr] : null;
  }

  function resizeAmountInput() {
    state.amountInput.style.width = (state.amountInput.value.length + 1) + 'ch';
  }
  function updateAmountColor() {
    const isIncome = getToggle('txf-type-toggle', 'type') === 'Income';
    const color = isIncome ? 'var(--accent)' : 'var(--negative)';
    state.amountInput.style.color = color;
    state.amountCurrency.style.color = color;
  }

  function showToast(msg) {
    if (!state.toast) return;
    state.toast.textContent = msg;
    state.toast.classList.add('show');
    setTimeout(() => state.toast.classList.remove('show'), 1400);
  }

  async function loadAccounts() {
    const sofEl = state.sofEl;
    try {
      const res = await fetch('/api/accounts-list');
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      sofEl.innerHTML = data.accounts.map((a) => `<option value="${a.name}">${a.name}</option>`).join('');
    } catch (err) {
      sofEl.innerHTML = '<option value="">Error loading accounts</option>';
    }
  }

  // Renders the Payee <datalist> from payeeCache, ordered by distance to
  // state.capturedPosition when a position is available (payees with no
  // stored coordinate sort after ones that have one), or plain alphabetical
  // otherwise -- see issue #52. Re-called both after a fresh /api/payees-list
  // fetch and whenever geolocation resolves (which can happen after the
  // initial fetch already rendered the alphabetical fallback).
  function renderPayeeOptions() {
    const payeeListEl = state.payeeListEl;
    if (!payeeListEl) return;
    const pos = state.capturedPosition;
    let ordered;
    if (pos) {
      ordered = payeeCache.slice().sort((a, b) => {
        const da = a.lat != null && a.lon != null ? haversineKm(pos, a) : Infinity;
        const db = b.lat != null && b.lon != null ? haversineKm(pos, b) : Infinity;
        if (da !== db) return da - db;
        return a.name.localeCompare(b.name);
      });
    } else {
      ordered = payeeCache.slice().sort((a, b) => a.name.localeCompare(b.name));
    }
    payeeListEl.innerHTML = ordered.map((p) => `<option value="${p.name}"></option>`).join('');
  }

  // Populates the Payee field's <datalist> with every known payee (now read
  // from the `Payees` tab, not `transactions` -- see issue #52) so typing
  // offers native browser autocomplete. Best-effort: the field stays a
  // normal free-text input either way, so a failure here just means no
  // suggestions rather than a broken form.
  async function loadPayees() {
    if (!state.payeeListEl) return;
    try {
      const res = await fetch('/api/payees-list');
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      payeeCache = data.payees || [];
      renderPayeeOptions();
    } catch (err) {
      // Silent -- autocomplete is a nice-to-have, not worth surfacing an error for.
    }
  }

  function hideLocToggle() {
    if (!state.locToggle) return;
    state.locToggle.style.display = 'none';
    state.locToggle.classList.remove('active');
    state.locHint.style.display = 'none';
    if (state.locDist) state.locDist.textContent = '';
  }

  function updateLocHint() {
    if (!state.locHint) return;
    state.locHint.textContent = state.locationEnabled
      ? 'This payee’s saved location will be updated to here.'
      : 'This payee’s saved location will NOT be updated.';
    state.locHint.style.display = 'block';
  }

  function formatDistanceKm(km) {
    return km < 1 ? Math.round(km * 1000) + 'm' : km.toFixed(1) + 'km';
  }

  // Distance from the captured device position to whichever payee is
  // currently typed into the field, shown right under the location-pin
  // toggle -- reuses the same haversineKm() already used to rank the
  // datalist (see issue #52 follow-up), just run once more against a
  // single payee instead of sorting all of them. Only shows a number when
  // BOTH a position is known and the typed name matches a payee that
  // already has a stored coordinate -- a new/unmatched payee or one with
  // no location on file yet just leaves this blank, same slot either way
  // so nothing shifts position.
  function updateDistanceLabel() {
    if (!state.locDist) return;
    const pos = state.capturedPosition;
    const typed = state.payeeEl.value.trim().toLowerCase();
    const match = pos && typed
      ? payeeCache.find((p) => p.name.trim().toLowerCase() === typed)
      : null;
    state.locDist.textContent = (match && match.lat != null && match.lon != null)
      ? formatDistanceKm(haversineKm(pos, match))
      : '';
  }

  // Best-effort geolocation capture for a NEW transaction only (see open()) --
  // never blocks the form, and a denial/timeout/error just leaves the toggle
  // hidden and the Payee list in its alphabetical fallback order. Guarded by
  // locRequestToken so a callback that resolves after the sheet has since
  // been closed/reopened (e.g. for a different transaction) is ignored.
  function requestLocation() {
    const token = ++locRequestToken;
    if (!global.navigator || !navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (token !== locRequestToken) return; // stale -- form moved on since this was requested
        state.capturedPosition = { lat: pos.coords.latitude, lon: pos.coords.longitude };
        state.locationEnabled = true; // defaults on -- logging while at/near the payee is still the common case
        state.locToggle.style.display = 'flex';
        state.locToggle.classList.add('active');
        updateLocHint();
        renderPayeeOptions();
        updateDistanceLabel();
      },
      () => { /* denied/unavailable/timeout -- silent, toggle just stays hidden */ },
      { enableHighAccuracy: false, timeout: 6000, maximumAge: 120000 }
    );
  }

  // opts.prefillAmount (add-mode only): pre-fills the Amount field with a raw
  // digit string/number and focuses Payee instead of Amount once open -- used
  // by the home page's ?amount= quick-add deep link (see issue #30) so a Siri
  // Shortcut only has to prompt for the amount before handing off here.
  function open(txn, opts) {
    opts = opts || {};
    state.formError.style.display = 'none';
    state.overlay.classList.add('open');
    const todayStr = todayISO();
    state.monthTouched = false;
    const isEditOpen = !!(txn && state.options.supportEditDelete);

    // Location capture only makes sense for a transaction being logged now --
    // editing an existing (possibly old) row doesn't imply you're currently
    // at the payee, so it's skipped entirely in edit mode (see issue #52).
    state.capturedPosition = null;
    state.locationEnabled = false;
    hideLocToggle();
    if (!isEditOpen) {
      requestLocation();
    } else {
      locRequestToken++; // invalidate any still-in-flight request from a previous open
    }
    renderPayeeOptions();

    if (isEditOpen) {
      state.editingRow = txn.rowNumber;
      state.sheetTitle.textContent = 'Edit transaction';
      state.payeeEl.value = txn.payee;
      state.sofEl.value = txn.sof;
      state.amountInput.value = formatAmountDisplay(digitsOnly(String(Math.round(txn.amount))));
      state.notesEl.value = txn.notes || '';
      state.dateInput.value = txn.date || todayStr;
      state.monthInput.value = txn.month || guessBillingMonth(state.dateInput.value);
      state.monthTouched = true; // editing an existing row -- don't override its saved month on open
      setToggle('txf-type-toggle', 'type', txn.type);
      setToggle('txf-status-toggle', 'status', txn.cleared === 'Cleared' ? 'Cleared' : 'Uncleared');
      state.deleteLink.style.display = 'block';
    } else {
      state.editingRow = null;
      state.sheetTitle.textContent = 'Add transaction';
      state.payeeEl.value = '';
      state.amountInput.value = opts.prefillAmount != null
        ? formatAmountDisplay(digitsOnly(String(opts.prefillAmount)))
        : '';
      state.notesEl.value = '';
      state.dateInput.value = todayStr;
      state.monthInput.value = guessBillingMonth(todayStr);
      setToggle('txf-type-toggle', 'type', 'Expense');
      // Default to Uncleared -- most transactions are logged before they've
      // actually posted/cleared on the account, so Uncleared is the more
      // accurate starting state. Cleared is still one tap away.
      setToggle('txf-status-toggle', 'status', 'Uncleared');
      state.deleteLink.style.display = 'none';
    }
    updateAmountColor();
    resizeAmountInput();

    // Autofocus the amount field for a new transaction so typing the amount
    // can start immediately -- but not when editing an existing one, where
    // jumping straight to the amount could be surprising / cause an
    // accidental edit before the rest of the fields have been reviewed. If
    // the amount arrived pre-filled (opts.prefillAmount), focus Payee next
    // instead, since Amount is already done.
    if (!isEditOpen) {
      if (opts.prefillAmount != null) {
        state.payeeEl.focus();
      } else {
        state.amountInput.focus();
      }
    }
  }

  function close() {
    state.overlay.classList.remove('open');
  }

  // Keeps payeeCache in sync with our OWN successful save, without an extra
  // /api/payees-list round-trip. This mirrors upsertPayee()'s own decision
  // logic server-side (see api/_lib/sheets.js) using the exact payload we
  // just POSTed and already know was accepted (handleSave only calls this
  // after `data.error` came back empty): existing payee + coords sent ->
  // overwrite; existing payee + no coords sent -> leave as-is; no matching
  // payee -> add one. Matching is case-insensitive to mirror the server's
  // own normalizePayeeName(), so "alpha cafe" doesn't get spliced in as a
  // second, distinct-looking entry next to a cached "Alpha Cafe". Only ever
  // called for a non-edit save -- transactions-update.js doesn't touch the
  // Payees registry at all, so an edit has nothing to splice.
  function upsertLocalPayeeCache(name, lat, lon) {
    const trimmedName = String(name || '').trim();
    if (!trimmedName) return;
    const key = trimmedName.toLowerCase();
    const hasCoords = lat != null && lon != null;
    const existing = payeeCache.find((p) => p.name.trim().toLowerCase() === key);
    if (existing) {
      if (hasCoords) { existing.lat = lat; existing.lon = lon; }
    } else {
      payeeCache.push({ name: trimmedName, lat: hasCoords ? lat : null, lon: hasCoords ? lon : null });
    }
  }

  async function handleSave() {
    const isEdit = state.options.supportEditDelete && state.editingRow !== null;

    const payload = {
      payee: state.payeeEl.value.trim(),
      type: getToggle('txf-type-toggle', 'type'),
      sof: state.sofEl.value,
      amount: digitsOnly(state.amountInput.value),
      date: state.dateInput.value,
      month: state.monthInput.value,
      cleared: getToggle('txf-status-toggle', 'status'),
      notes: state.notesEl.value.trim(),
    };

    // Only a new transaction can carry a captured position, and only when
    // the location-pin toggle was left on -- see requestLocation()/open()
    // and the toggle click handler in mount() below.
    if (!isEdit && state.capturedPosition && state.locationEnabled) {
      payload.lat = state.capturedPosition.lat;
      payload.lon = state.capturedPosition.lon;
      payload.updatePayeeLocation = true;
    } else {
      payload.updatePayeeLocation = false;
    }

    if (!payload.payee || !payload.sof || !payload.amount || !payload.date || !payload.month) {
      state.formError.textContent = 'Payee, account, amount, date, and month are required.';
      state.formError.style.display = 'block';
      return;
    }

    state.saveBtn.disabled = true;
    state.formError.style.display = 'none';
    try {
      const url = isEdit ? '/api/transactions-update' : '/api/transactions-add';
      const body = isEdit ? { ...payload, rowNumber: state.editingRow } : payload;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Mnab-Token': WRITE_TOKEN },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      if (!isEdit) {
        upsertLocalPayeeCache(payload.payee, payload.lat, payload.lon);
        renderPayeeOptions();
      }
      close();
      showToast('Saved');
      if (typeof state.options.onSaved === 'function') state.options.onSaved(payload, isEdit);
    } catch (err) {
      state.formError.textContent = err.message;
      state.formError.style.display = 'block';
    } finally {
      state.saveBtn.disabled = false;
    }
  }

  async function handleDelete() {
    if (state.editingRow === null) return;
    if (!confirm('Delete this transaction?')) return;
    try {
      const res = await fetch('/api/transactions-delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rowNumber: state.editingRow }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      const deletedRow = state.editingRow;
      close();
      showToast('Deleted');
      if (typeof state.options.onDeleted === 'function') state.options.onDeleted(deletedRow);
    } catch (err) {
      state.formError.textContent = err.message;
      state.formError.style.display = 'block';
    }
  }

  function mount(rootEl, options) {
    options = options || {};
    rootEl.innerHTML = FORM_HTML;

    state = {
      options,
      editingRow: null,
      monthTouched: false,
      capturedPosition: null,
      locationEnabled: false,
      overlay: rootEl.querySelector('#txf-overlay'),
      sheetTitle: rootEl.querySelector('#txf-sheet-title'),
      sheetClose: rootEl.querySelector('#txf-sheet-close'),
      fab: rootEl.querySelector('#txf-fab'),
      toast: rootEl.querySelector('#txf-toast'),
      formError: rootEl.querySelector('#txf-form-error'),
      amountInput: rootEl.querySelector('#txf-f-amount'),
      amountCurrency: rootEl.querySelector('#txf-amount-currency'),
      payeeEl: rootEl.querySelector('#txf-f-payee'),
      payeeListEl: rootEl.querySelector('#txf-payee-list'),
      locToggle: rootEl.querySelector('#txf-loc-toggle'),
      locHint: rootEl.querySelector('#txf-loc-hint'),
      locDist: rootEl.querySelector('#txf-loc-dist'),
      sofEl: rootEl.querySelector('#txf-f-sof'),
      dateInput: rootEl.querySelector('#txf-f-date'),
      monthInput: rootEl.querySelector('#txf-f-month'),
      notesEl: rootEl.querySelector('#txf-f-notes'),
      saveBtn: rootEl.querySelector('#txf-save-btn'),
      deleteLink: rootEl.querySelector('#txf-delete-link'),
    };

    if (options.showFab === false) {
      state.fab.style.display = 'none';
    }

    state.amountInput.addEventListener('input', () => {
      state.amountInput.value = formatAmountDisplay(digitsOnly(state.amountInput.value));
      resizeAmountInput();
    });

    rootEl.querySelectorAll('#txf-type-toggle .txf-toggle-btn').forEach((b) =>
      b.addEventListener('click', () => {
        setToggle('txf-type-toggle', 'type', b.dataset.type);
        updateAmountColor();
      }));
    rootEl.querySelectorAll('#txf-status-toggle .txf-toggle-btn').forEach((b) =>
      b.addEventListener('click', () => setToggle('txf-status-toggle', 'status', b.dataset.status)));

    state.locToggle.addEventListener('click', () => {
      state.locationEnabled = !state.locationEnabled;
      state.locToggle.classList.toggle('active', state.locationEnabled);
      updateLocHint();
    });
    // Recompute the distance label as the Payee field changes -- typing,
    // picking a datalist suggestion, or clearing it all fire 'input'.
    state.payeeEl.addEventListener('input', updateDistanceLabel);

    state.monthInput.addEventListener('input', () => { state.monthTouched = true; });
    state.dateInput.addEventListener('change', () => {
      if (!state.monthTouched) state.monthInput.value = guessBillingMonth(state.dateInput.value);
    });

    state.fab.addEventListener('click', () => open(null));
    state.sheetClose.addEventListener('click', close);
    state.overlay.addEventListener('click', (e) => { if (e.target === state.overlay) close(); });
    state.saveBtn.addEventListener('click', handleSave);
    state.deleteLink.addEventListener('click', handleDelete);

    loadAccounts();
    loadPayees();
  }

  global.TransactionForm = { mount, open, close, todayISO, guessBillingMonth };
})(window);
