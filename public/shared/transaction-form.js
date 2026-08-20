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
        <input id="txf-f-payee" class="txf-field" type="text" placeholder="e.g. Sushi Hiro, Plaza Indonesia" />

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
        <div class="txf-hint">Billing month defaults to the date's month — override for card statement cycles.</div>

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
    if (d.getDate() > 12) d.setMonth(d.getMonth() + 1);
    return monthValue(d);
  }

  function digitsOnly(str) {
    return (str || '').replace(/[^\d]/g, '');
  }
  function formatAmountDisplay(digits) {
    return digits.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  }

  let state = null; // set up on mount()

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

  function open(txn) {
    state.formError.style.display = 'none';
    state.overlay.classList.add('open');
    const todayStr = todayISO();
    state.monthTouched = false;

    if (txn && state.options.supportEditDelete) {
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
      state.amountInput.value = '';
      state.notesEl.value = '';
      state.dateInput.value = todayStr;
      state.monthInput.value = guessBillingMonth(todayStr);
      setToggle('txf-type-toggle', 'type', 'Expense');
      setToggle('txf-status-toggle', 'status', 'Cleared');
      state.deleteLink.style.display = 'none';
    }
    updateAmountColor();
    resizeAmountInput();
  }

  function close() {
    state.overlay.classList.remove('open');
  }

  async function handleSave() {
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

    if (!payload.payee || !payload.sof || !payload.amount || !payload.date || !payload.month) {
      state.formError.textContent = 'Payee, account, amount, date, and month are required.';
      state.formError.style.display = 'block';
      return;
    }

    state.saveBtn.disabled = true;
    state.formError.style.display = 'none';
    try {
      const isEdit = state.options.supportEditDelete && state.editingRow !== null;
      const url = isEdit ? '/api/transactions-update' : '/api/transactions-add';
      const body = isEdit ? { ...payload, rowNumber: state.editingRow } : payload;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
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
      overlay: rootEl.querySelector('#txf-overlay'),
      sheetTitle: rootEl.querySelector('#txf-sheet-title'),
      sheetClose: rootEl.querySelector('#txf-sheet-close'),
      fab: rootEl.querySelector('#txf-fab'),
      toast: rootEl.querySelector('#txf-toast'),
      formError: rootEl.querySelector('#txf-form-error'),
      amountInput: rootEl.querySelector('#txf-f-amount'),
      amountCurrency: rootEl.querySelector('#txf-amount-currency'),
      payeeEl: rootEl.querySelector('#txf-f-payee'),
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
  }

  global.TransactionForm = { mount, open, close, todayISO, guessBillingMonth };
})(window);
