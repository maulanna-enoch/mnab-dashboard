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
          <button type="button" class="txf-sheet-close" id="txf-sheet-close">&times;</button>
        </div>

        <div class="txf-match-banner" id="txf-match-banner" style="display:none;">
          <div class="txf-match-banner-text">This imported transaction looks like it matches one you entered manually.</div>
          <div class="txf-match-banner-actions">
            <button type="button" class="txf-match-decline-btn" id="txf-match-decline-btn">Not a match</button>
            <button type="button" class="txf-match-confirm-btn" id="txf-match-confirm-btn">Confirm match</button>
          </div>
        </div>

        <div class="txf-toggle-row" id="txf-type-toggle">
          <button class="txf-toggle-btn" data-type="Expense">Expense</button>
          <button class="txf-toggle-btn" data-type="Income">Income</button>
          <button class="txf-toggle-btn" data-type="Transfer" id="txf-type-transfer-btn">Transfer</button>
        </div>

        <label class="txf-amount-block" for="txf-f-amount">
          <div class="txf-amount-label">Amount</div>
          <div class="txf-amount-row">
            <span class="txf-amount-currency" id="txf-amount-currency">Rp</span>
            <input id="txf-f-amount" class="txf-amount-input" type="text" inputmode="numeric" placeholder="0" />
          </div>
          <div class="txf-amount-rule"></div>
        </label>

        <div id="txf-payee-group">
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
        </div>

        <label class="txf-field-label" id="txf-sof-label" for="txf-f-sof">Account (SOF)</label>
        <select id="txf-f-sof" class="txf-field"></select>

        <div id="txf-transfer-to-group" style="display:none;">
          <label class="txf-field-label" id="txf-to-label" for="txf-f-to">To account</label>
          <select id="txf-f-to" class="txf-field"></select>
        </div>

        <div class="txf-pair-block" id="txf-pair-block" style="display:none;">
          <div class="txf-pair-title" id="txf-pair-title"></div>
          <div id="txf-pair-list"></div>
        </div>

        <div class="txf-row-2">
          <div>
            <label class="txf-field-label">Date</label>
            <input id="txf-f-date" class="txf-field" type="date" />
          </div>
          <div>
            <label class="txf-field-label" id="txf-month-label" for="txf-f-month">Billing month</label>
            <input id="txf-f-month" class="txf-field" type="month" />
          </div>
        </div>

        <div class="txf-row-2" id="txf-to-month-row" style="display:none;">
          <div></div>
          <div>
            <label class="txf-field-label" id="txf-to-month-label" for="txf-f-to-month">To billing month</label>
            <input id="txf-f-to-month" class="txf-field" type="month" />
          </div>
        </div>

        <div class="txf-transfer-hint" id="txf-transfer-hint" style="display:none;"></div>
        <div class="txf-billed-check" id="txf-billed-check"></div>

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

  // Same "is this a credit card?" check used everywhere else in the app
  // (accounts/index.html's isCredit, getCashAccounts(), etc.) -- centralized
  // here so guessBillingMonth() and every page that calls it agree on what
  // counts as a cash account. Blank/unknown type reads as cash, matching
  // that existing convention.
  function isCashAccountType(type) {
    return !(type || '').toLowerCase().includes('credit');
  }

  // Billing-month pre-fill. Two different heuristics depending on the
  // account (see issue -- "billing month guess ignores cash-account
  // statement cycles"):
  //   - Credit cards (isCash === false): day 1-12 of the month -> that same
  //     month, day 13+ -> the next month. Same heuristic used in
  //     Reconcile.gs and the reconciliation dialog.
  //   - Cash/bank accounts (isCash === true, also the default when the
  //     account's type can't be determined yet): statement cycle runs the
  //     25th of a month through the 24th of the next one, and the whole
  //     cycle is named after the month it *starts* in -- day 1-24 belongs
  //     to the previous month, day 25+ belongs to this one.
  // Either way this is only a starting guess, always fully editable -- a
  // "touched" flag stops it from overwriting a manual edit once you've
  // changed it yourself.
  function guessBillingMonth(dateStr, isCash) {
    const d = new Date(dateStr + 'T00:00:00');
    if (isCash) {
      // Snap to day 1 first in both branches -- setMonth() on a date still
      // holding a late day-of-month can overflow into the wrong month (e.g.
      // Jan 31 minus one month would land on Jan 3, not Dec 1).
      if (d.getDate() < 25) {
        d.setDate(1);
        d.setMonth(d.getMonth() - 1);
      } else {
        d.setDate(1);
      }
    } else if (d.getDate() > 12) {
      // Snap to day 1 before incrementing the month -- otherwise a date like
      // Aug 31 rolls into October (September only has 30 days), overshooting
      // the guess by an extra month.
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
    const type = getToggle('txf-type-toggle', 'type');
    // A transfer is neither spending nor income -- money just moves between
    // two of your own accounts -- so it gets the neutral text colour.
    const color = type === 'Transfer' ? 'var(--text)' : (type === 'Income' ? 'var(--accent)' : 'var(--negative)');
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
      state.accountsCache = data.accounts || [];
      sofEl.innerHTML = data.accounts.map((a) => `<option value="${a.name}">${a.name}</option>`).join('');
      // An edit sheet opened before this resolved couldn't know which
      // accounts are cards yet -- re-check now that it can.
      if (state.overlay.classList.contains('open')) {
        if (state.editingTxn) state.sofEl.value = state.editingTxn.sof;
        if (isTransferMode()) applyTypeMode();
      }
    } catch (err) {
      sofEl.innerHTML = '<option value="">Error loading accounts</option>';
    }
  }

  // ── Convert to transfer ─────────────────────────────────────────────────
  // An imported bank row is often only ONE half of a move between two of
  // the user's own accounts -- EmailImport.gs can only ever log an OCBC
  // "transfer to other bank" or "Successful Bill Payment" as a plain
  // Expense, or an incoming transfer as a plain Income. Tapping Transfer on
  // the Edit sheet converts THAT row into one leg of a Transfer=TRUE pair:
  // an Expense row is the "from" leg, an Income row the "to" leg, and the
  // other select picks the other account. The other leg is either written
  // fresh, or -- when the other half was imported separately -- an existing
  // row there is linked into the pair instead of duplicating it (the pair
  // block lists likely candidates: same amount, opposite type, within a
  // week). See api/reconcile.js's actionConvertToTransfer.
  //
  // A cash/bank -> credit card conversion is a card payment (this replaces
  // the old "Convert to card payment" link): the Billing month field becomes
  // the card statement being paid (both legs get it, same as Add Payment),
  // and the card's Diary line is marked Paid when the amount covers it.
  function canConvertToTransfer() {
    const txn = state.editingTxn;
    if (!txn || !state.options.supportEditDelete) return false;
    return !txn.transfer && !txn.paymentId;
  }

  function isConvertMode() {
    return state.editingRow !== null && !!state.editingTxn && isTransferMode();
  }

  // The edited row keeps its own Expense/Income type -- that's what decides
  // which side of the transfer it is.
  function convertThisIsFrom() {
    return state.convertBaseType !== 'Income';
  }

  function convertAccounts() {
    const thisAcct = accountByName(state.sofEl.value);
    const otherAcct = accountByName(state.transferToEl.value);
    return convertThisIsFrom()
      ? { from: thisAcct, to: otherAcct }
      : { from: otherAcct, to: thisAcct };
  }

  // Same rule as the server: money leaving a cash/bank account for a card.
  function isConvertCardPayment() {
    if (!isConvertMode() || !state.transferToEl.value) return false;
    const { from, to } = convertAccounts();
    if (!from || !to) return false;
    return isCashAccountType(from.type) && !isCashAccountType(to.type);
  }

  // Same default as the Accounts page's Add Payment / api actionPayCard:
  // the CARD's statement-month guess for the payment date, minus one -- a
  // payment made now normally pays the prior, already-closed statement.
  function guessPaidStatementMonth(dateStr) {
    if (!dateStr) return '';
    const guess = guessBillingMonth(dateStr, false); // card rule, deliberately
    const d = new Date(guess + '-01T00:00:00');
    d.setMonth(d.getMonth() - 1); // day already 1 -- no overflow
    return monthValue(d);
  }

  function formatRp(n) {
    return 'Rp' + formatAmountDisplay(String(Math.round(Math.abs(n))));
  }

  // dd/mm/yyyy -- the project's display convention for dates.
  function formatDateDMY(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
    return m ? `${m[3]}/${m[2]}/${m[1]}` : (iso || '');
  }

  function escapeHtml(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // Card payment: the Billing month field is relabelled "Card statement
  // month" and pre-filled with the paid-statement guess; the row's own
  // saved month is remembered and put back if the conversion stops being a
  // card payment (other account changed, or Type toggled away).
  function applyConvertMonths() {
    const card = isConvertCardPayment();
    if (card) {
      if (!state.statementMonthApplied) {
        state.monthBeforeStatement = state.monthInput.value;
        state.monthInput.value = guessPaidStatementMonth(state.dateInput.value) || state.monthInput.value;
        state.statementMonthApplied = true;
        state.statementMonthTouched = false;
      }
      state.monthLabel.textContent = 'Card statement month';
      state.toMonthRow.style.display = 'none';
    } else {
      restoreStatementMonth();
      state.monthLabel.textContent = 'Billing month';
      const other = state.transferToEl.value;
      state.toMonthRow.style.display = other ? '' : 'none';
      state.toMonthLabel.textContent = other ? `${other} billing month` : 'Other billing month';
    }
  }

  function restoreStatementMonth() {
    if (!state.statementMonthApplied) return;
    state.monthInput.value = state.monthBeforeStatement;
    state.statementMonthApplied = false;
  }

  function visibleCandidates() {
    const other = state.transferToEl.value;
    return other ? state.candidates.filter((c) => c.sof === other) : state.candidates;
  }

  // When the chosen other account has candidates and the user hasn't said
  // "add a new entry instead" for it, pre-pick the closest one -- writing a
  // duplicate of a row that's already there is the worse mistake, and the
  // pick is shown plainly with a one-tap opt-out.
  function autoPickLink() {
    const other = state.transferToEl.value;
    if (state.linkRow && state.linkRow.sof !== other) state.linkRow = null;
    if (!other || state.linkRow || state.pairDeclined.has(other)) return;
    const first = state.candidates.find((c) => c.sof === other);
    if (first) setLinkRow(first);
  }

  function setLinkRow(cand) {
    state.linkRow = cand || null;
    // A linked row already has its own billing month -- use it as the
    // other-leg month unless the user set that field by hand.
    if (cand && cand.month && !state.toMonthTouched) state.toMonthInput.value = cand.month;
    if (!cand && !state.toMonthTouched) refreshToMonthGuess();
  }

  function renderPairBlock() {
    const list = visibleCandidates();
    if (!isConvertMode() || !list.length) {
      state.pairBlock.style.display = 'none';
      state.pairList.innerHTML = '';
      return;
    }
    const other = state.transferToEl.value;
    const otherType = convertThisIsFrom() ? 'income' : 'expense';
    state.pairTitle.textContent = other
      ? `Already imported on ${other}? Link it instead of adding a new ${otherType}:`
      : `Possible other half found (same amount, ${otherType}):`;
    const linked = state.linkRow ? state.linkRow.rowNumber : null;
    let html = list.map((c) => `
      <button type="button" class="txf-pair-opt${c.rowNumber === linked ? ' active' : ''}" data-row="${c.rowNumber}" aria-pressed="${c.rowNumber === linked}">
        <div class="txf-pair-opt-main">${escapeHtml(c.payee || '(no payee)')}</div>
        <div class="txf-pair-opt-meta">${escapeHtml(c.sof)} · ${escapeHtml(formatDateDMY(c.date))} · ${escapeHtml(formatRp(c.amount))}${c.notes ? ' · ' + escapeHtml(c.notes) : ''}</div>
      </button>`).join('');
    if (other) {
      html += `<button type="button" class="txf-pair-opt txf-pair-opt-new${linked ? '' : ' active'}" data-row="" aria-pressed="${!linked}">No — add a new ${otherType} on ${escapeHtml(other)}</button>`;
    }
    state.pairList.innerHTML = html;
    state.pairBlock.style.display = 'block';
  }

  function onPairClick(e) {
    const btn = e.target.closest('.txf-pair-opt');
    if (!btn) return;
    state.formError.style.display = 'none';
    const rn = btn.dataset.row ? parseInt(btn.dataset.row, 10) : null;
    if (!rn) {
      state.pairDeclined.add(state.transferToEl.value);
      setLinkRow(null);
    } else {
      const cand = state.candidates.find((c) => c.rowNumber === rn);
      if (!cand) return;
      state.pairDeclined.delete(cand.sof);
      if (state.transferToEl.value !== cand.sof) {
        state.transferToEl.value = cand.sof;
      }
      setLinkRow(cand);
    }
    refreshConvertUI();
  }

  function updateConvertHint() {
    const other = state.transferToEl.value;
    if (!other) {
      state.transferHintEl.innerHTML = '';
      state.transferHintEl.style.display = 'none';
      return;
    }
    const here = state.sofEl.value;
    const out = convertThisIsFrom();
    const lines = [
      `This entry stays on <b>${escapeHtml(here)}</b> as the money ${out ? 'going out' : 'coming in'}.`,
    ];
    if (state.linkRow) {
      lines.push(`It’s paired with the existing <b>${escapeHtml(other)}</b> entry from ${escapeHtml(formatDateDMY(state.linkRow.date))} — nothing new is added.`);
    } else {
      lines.push(`A matching ${out ? 'income' : 'expense'} is added to <b>${escapeHtml(other)}</b>.`);
    }
    lines.push(isConvertCardPayment()
      ? 'Both are marked as a card payment, so this no longer counts as spending.'
      : `Both are marked as a transfer, so this no longer counts as ${out ? 'spending' : 'income'}.`);
    state.transferHintEl.innerHTML = lines.map((l) => `<div>${l}</div>`).join('');
    state.transferHintEl.style.display = 'block';
  }

  // Read-only: for a card payment, shows the card's Diary "Billed" amount
  // for the statement month next to this row's amount, as a sanity check
  // that the right card/month is picked. Same endpoint the Add Payment form
  // pre-fills from. Guarded by a request token so a slow answer for a
  // previous pick is dropped.
  let billedRequestToken = 0;
  async function refreshBilledCheck() {
    const token = ++billedRequestToken;
    const el = state.billedEl;
    el.className = 'txf-billed-check';
    if (!isConvertCardPayment()) { el.textContent = ''; return; }
    const card = convertAccounts().to.name;
    const month = state.monthInput.value;
    if (!month) { el.textContent = ''; return; }
    el.textContent = 'Checking statement…';
    try {
      const res = await fetch('/api/reconcile?action=billed-amount&cardAccount=' + encodeURIComponent(card) + '&month=' + encodeURIComponent(month));
      const data = await res.json();
      if (token !== billedRequestToken) return;
      if (data.error) throw new Error(data.error);
      if (!data.found) {
        el.textContent = `No unpaid ${card} statement found for this month.`;
        return;
      }
      const paid = Number(digitsOnly(state.amountInput.value)) || 0;
      const diff = paid - data.amount;
      if (Math.abs(diff) < 0.5) {
        el.textContent = `Statement billed ${formatRp(data.amount)} — matches, will be marked Paid.`;
        el.classList.add('match');
      } else if (diff > 0) {
        el.textContent = `Statement billed ${formatRp(data.amount)} — this is ${formatRp(diff)} more; it will be marked Paid.`;
        el.classList.add('match');
      } else {
        el.textContent = `Statement billed ${formatRp(data.amount)} — this is ${formatRp(diff)} short, so it stays Billed.`;
        el.classList.add('mismatch');
      }
    } catch (err) {
      if (token === billedRequestToken) el.textContent = '';
    }
  }

  // Asks the server for rows that look like this one's other half. Re-run
  // when the amount or date changes (debounced); guarded by a token.
  let candidatesToken = 0;
  let candidatesTimer = null;
  async function fetchCandidates() {
    const token = ++candidatesToken;
    const amount = digitsOnly(state.amountInput.value);
    const date = state.dateInput.value;
    if (!isConvertMode() || !amount || !date) {
      state.candidates = [];
      refreshConvertUI();
      return;
    }
    const qs = new URLSearchParams({
      action: 'transfer-candidates',
      rowNumber: String(state.editingRow),
      account: state.sofEl.value,
      type: state.convertBaseType,
      amount,
      date,
    });
    try {
      const res = await fetch('/api/reconcile?' + qs.toString());
      const data = await res.json();
      if (token !== candidatesToken || !isConvertMode()) return;
      if (data.error) throw new Error(data.error);
      state.candidates = data.candidates || [];
    } catch (err) {
      if (token !== candidatesToken) return;
      state.candidates = []; // best-effort -- converting still works, it just writes a new leg
    }
    // Drop a link that no longer qualifies (amount/date edited since).
    if (state.linkRow && !state.candidates.some((c) => c.rowNumber === state.linkRow.rowNumber)) setLinkRow(null);
    refreshConvertUI();
  }
  function scheduleCandidates() {
    if (!isConvertMode()) return;
    clearTimeout(candidatesTimer);
    candidatesTimer = setTimeout(fetchCandidates, 400);
  }

  // Re-derives everything the convert mode shows from the current picks.
  function refreshConvertUI() {
    if (!isConvertMode()) return;
    autoPickLink();
    applyConvertMonths();
    renderPairBlock();
    updateConvertHint();
    refreshBilledCheck();
    state.saveBtn.textContent = isConvertCardPayment() ? 'Convert to card payment' : 'Convert to transfer';
  }

  async function handleConvertSave() {
    const card = isConvertCardPayment();
    const payload = {
      action: 'convert-to-transfer',
      rowNumber: state.editingRow,
      sof: state.sofEl.value,
      type: state.convertBaseType,
      otherAccount: state.transferToEl.value,
      payee: state.payeeEl.value.trim(),
      amount: digitsOnly(state.amountInput.value),
      date: state.dateInput.value,
      month: state.monthInput.value,
      otherMonth: card ? state.monthInput.value : state.toMonthInput.value,
      cleared: getToggle('txf-status-toggle', 'status'),
      notes: state.notesEl.value.trim(),
      linkRowNumber: state.linkRow ? state.linkRow.rowNumber : null,
    };
    const err = (msg, focusEl) => {
      state.formError.textContent = msg;
      state.formError.style.display = 'block';
      if (focusEl) focusEl.focus();
    };
    if (!payload.otherAccount) {
      return err(`Choose the account this ${convertThisIsFrom() ? 'went to' : 'came from'}.`, state.transferToEl);
    }
    if (payload.otherAccount === payload.sof) return err('From and To must be different accounts.');
    if (!payload.payee || !payload.amount || Number(payload.amount) <= 0 || !payload.date || !payload.month || !payload.otherMonth) {
      return err(card
        ? 'Payee, amount, date and card statement month are required.'
        : 'Payee, amount, date and both billing months are required.');
    }
    if (state.linkRow && Math.abs(Number(payload.amount) - state.linkRow.amount) >= 0.5) {
      return err(`The amount no longer matches the ${payload.otherAccount} entry you linked.`);
    }

    state.saveBtn.disabled = true;
    state.formError.style.display = 'none';
    try {
      const res = await fetch('/api/reconcile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Mnab-Token': WRITE_TOKEN },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      close();
      showToast(data.cardPayment
        ? (data.diaryFlipped ? 'Card payment saved · statement Paid' : 'Converted to card payment')
        : (data.linked ? 'Linked as a transfer' : 'Converted to transfer'));
      if (typeof state.options.onSaved === 'function') state.options.onSaved(payload, true);
    } catch (e) {
      err(e.message);
    } finally {
      state.saveBtn.disabled = false;
    }
  }

  // ── Transfer between two accounts ───────────────────────────────────────
  // The third Type option, offered on Add only. Moving money between two of
  // your own accounts is written as the same two-leg, Transfer=TRUE shape a
  // card payment uses -- an Expense on the "from" account and an Income on
  // the "to" account, sharing one Payment ID -- so both balances move while
  // the Diary's "<>TRUE" Transfer criteria keep it out of spend/income. The
  // Payment ID gets a 'trf_' prefix so the existing undo-payment path
  // deletes both legs (and skips the card-statement Diary flip, which only
  // makes sense for a real card payment). See api/reconcile.js's
  // actionTransfer.
  //
  // In this mode the Account (SOF) select is relabelled "From account" and
  // is the from-leg; a second select picks the to-leg. Payee is hidden --
  // each leg's payee is generated ("Transfer to X" / "Transfer from Y"),
  // same convention as Add Payment's "Payment to/from" -- so these never
  // land in the Payees registry either. Each leg gets its own billing month,
  // since the two accounts can follow different heuristics (cash 25th-cycle
  // vs. card day-13); the existing Billing month field is the from-leg's.
  function isTransferMode() {
    return getToggle('txf-type-toggle', 'type') === 'Transfer';
  }

  function accountByName(name) {
    return (state.accountsCache || []).find((a) => a.name === name);
  }

  function toAccountIsCash() {
    const acct = accountByName(state.transferToEl.value);
    return isCashAccountType(acct ? acct.type : undefined);
  }

  // Every account except the one being transferred from. Starts on a
  // placeholder rather than guessing (same "make it an explicit pick" rule
  // as Convert's card select), but keeps the current pick across a
  // re-render if it's still valid.
  function populateTransferTo() {
    const from = state.sofEl.value;
    const prev = state.transferToEl.value;
    const options = (state.accountsCache || []).filter((a) => a.name !== from);
    state.transferToEl.innerHTML = '<option value="">Choose an account…</option>' +
      options.map((a) => `<option value="${escapeHtml(a.name)}">${escapeHtml(a.name)}</option>`).join('');
    state.transferToEl.value = options.some((a) => a.name === prev) ? prev : '';
  }

  function refreshToMonthGuess() {
    if (state.toMonthTouched) return;
    state.toMonthInput.value = state.transferToEl.value && state.dateInput.value
      ? guessBillingMonth(state.dateInput.value, toAccountIsCash())
      : '';
  }

  function updateTransferHint() {
    const from = state.sofEl.value;
    const to = state.transferToEl.value;
    if (!from || !to) {
      state.transferHintEl.innerHTML = '';
      state.transferHintEl.style.display = 'none';
      return;
    }
    const lines = [
      `Adds money going out of <b>${escapeHtml(from)}</b> and the same amount coming into <b>${escapeHtml(to)}</b>.`,
      'Both are marked as a transfer, so this doesn’t count as spending or income.',
    ];
    const toAcct = accountByName(to);
    if (toAcct && !isCashAccountType(toAcct.type)) {
      lines.push(`Paying off a card statement? Use <b>Add Payment</b> on ${escapeHtml(to)}’s account page instead, so the statement gets marked Paid.`);
    }
    state.transferHintEl.innerHTML = lines.map((l) => `<div>${l}</div>`).join('');
    state.transferHintEl.style.display = 'block';
  }

  // Shows/hides the transfer-only fields for whichever Type is active.
  // Called on every Type toggle and on open(). On the Edit sheet, Transfer
  // means "convert this row" (see the Convert to transfer section above):
  // Payee stays (it's this row's payee), this row's account is fixed, and
  // the second select picks the other side.
  function applyTypeMode() {
    const transfer = isTransferMode();
    const convert = transfer && isConvertMode();
    state.payeeGroup.style.display = transfer && !convert ? 'none' : '';
    state.transferToGroup.style.display = transfer ? '' : 'none';
    state.sofEl.disabled = convert;
    if (convert) {
      const out = convertThisIsFrom();
      state.sofLabel.textContent = out ? 'From account (this entry)' : 'To account (this entry)';
      state.transferToLabel.textContent = out ? 'To account' : 'From account';
      state.deleteLink.style.display = 'none';
      populateTransferTo();
      refreshToMonthGuess();
      refreshConvertUI();
      return;
    }
    // Leaving convert mode (or never in it): undo its relabelling.
    restoreStatementMonth();
    state.pairBlock.style.display = 'none';
    billedRequestToken++;
    state.billedEl.textContent = '';
    state.saveBtn.textContent = 'Save';
    state.transferToLabel.textContent = 'To account';
    state.toMonthLabel.textContent = 'To billing month';
    state.toMonthRow.style.display = transfer ? '' : 'none';
    state.sofLabel.textContent = transfer ? 'From account' : 'Account (SOF)';
    state.monthLabel.textContent = transfer ? 'From billing month' : 'Billing month';
    if (state.editingRow !== null) state.deleteLink.style.display = 'block';
    if (transfer) {
      populateTransferTo();
      refreshToMonthGuess();
      updateTransferHint();
    } else {
      state.transferHintEl.style.display = 'none';
    }
  }

  async function handleTransferSave() {
    const payload = {
      action: 'transfer',
      fromAccount: state.sofEl.value,
      toAccount: state.transferToEl.value,
      amount: digitsOnly(state.amountInput.value),
      date: state.dateInput.value,
      fromMonth: state.monthInput.value,
      toMonth: state.toMonthInput.value,
      cleared: getToggle('txf-status-toggle', 'status'),
      notes: state.notesEl.value.trim(),
    };
    if (!payload.toAccount) {
      state.formError.textContent = 'Choose the account to transfer to.';
      state.formError.style.display = 'block';
      state.transferToEl.focus();
      return;
    }
    if (payload.fromAccount === payload.toAccount) {
      state.formError.textContent = 'From and To must be different accounts.';
      state.formError.style.display = 'block';
      return;
    }
    if (!payload.fromAccount || !payload.amount || Number(payload.amount) <= 0 || !payload.date || !payload.fromMonth || !payload.toMonth) {
      state.formError.textContent = 'Accounts, amount, date, and both billing months are required.';
      state.formError.style.display = 'block';
      return;
    }

    state.saveBtn.disabled = true;
    state.formError.style.display = 'none';
    try {
      const res = await fetch('/api/reconcile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Mnab-Token': WRITE_TOKEN },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      close();
      showToast('Transfer saved');
      if (typeof state.options.onSaved === 'function') state.options.onSaved(payload, false);
    } catch (err) {
      state.formError.textContent = err.message;
      state.formError.style.display = 'block';
    } finally {
      state.saveBtn.disabled = false;
    }
  }

  // Whether the currently-selected SOF is a cash/bank account (vs. a credit
  // card) -- see guessBillingMonth(). Defaults to true (cash) when the
  // accounts list hasn't loaded yet or the selected name isn't found, same
  // "unknown reads as cash" convention as isCashAccountType() itself.
  function currentSofIsCash() {
    const accounts = state.accountsCache || [];
    const acct = accounts.find((a) => a.name === state.sofEl.value);
    return isCashAccountType(acct ? acct.type : undefined);
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

  // Location capture is offered for edit opens too, not just new
  // transactions (see issue #52's original, more conservative edit-mode
  // exclusion -- relaxed per a follow-up request: editing an existing row
  // doesn't *guarantee* you're at the payee, but you might well still be
  // -- e.g. fixing a typo/amount moments after logging it -- so the same
  // best-effort, non-blocking capture + opt-in toggle is offered either
  // way). Never blocks the form, and a denial/timeout/error just leaves the
  // toggle hidden and the Payee list in its alphabetical fallback order.
  // Guarded by locRequestToken so a callback that resolves after the sheet
  // has since been closed/reopened (e.g. for a different transaction) is
  // ignored.
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
    state.editingTxn = isEditOpen ? txn : null;
    state.saveBtn.style.display = '';
    // On Add, Transfer writes a fresh two-leg pair. On Edit it converts this
    // row into one leg of a pair (see "Convert to transfer") -- offered only
    // for a row that isn't already a leg of one.
    state.editingRow = isEditOpen ? txn.rowNumber : null;
    state.transferBtn.style.display = !isEditOpen || canConvertToTransfer() ? '' : 'none';
    state.toMonthTouched = false;
    state.convertBaseType = isEditOpen && txn.type === 'Income' ? 'Income' : 'Expense';
    state.candidates = [];
    state.linkRow = null;
    state.pairDeclined = new Set();
    state.statementMonthApplied = false;
    candidatesToken++;
    clearTimeout(candidatesTimer);
    if (isEditOpen) state.transferToEl.value = '';

    // Location capture is offered for edit opens too, not just new
    // transactions (see issue #52's original, more conservative edit-mode
    // exclusion -- relaxed per a follow-up request: editing an existing row
    // doesn't *guarantee* you're at the payee, but you might well still be
    // -- e.g. fixing a typo/amount moments after logging it -- so the same
    // best-effort, non-blocking capture + opt-in toggle is offered either
    // way. requestLocation() itself bumps locRequestToken, which is what
    // invalidates any still-in-flight request from a previous open.
    state.capturedPosition = null;
    state.locationEnabled = false;
    hideLocToggle();
    requestLocation();
    renderPayeeOptions();

    // Issue #51: a proposed match (self-provisioned Match ID/Match Status
    // columns, stamped by EmailImport.gs at import time) surfaces here as a
    // banner with Confirm/Decline actions -- only ever shown on an edit open
    // of a row that actually carries one, never on Add.
    if (isEditOpen && txn.matchStatus === 'Proposed' && txn.matchId) {
      state.currentMatchId = txn.matchId;
      state.matchBanner.style.display = 'block';
    } else {
      state.currentMatchId = null;
      state.matchBanner.style.display = 'none';
    }

    if (isEditOpen) {
      state.editingRow = txn.rowNumber;
      state.sheetTitle.textContent = 'Edit transaction';
      state.payeeEl.value = txn.payee;
      state.sofEl.value = txn.sof;
      state.amountInput.value = formatAmountDisplay(digitsOnly(String(Math.round(txn.amount))));
      state.notesEl.value = txn.notes || '';
      state.dateInput.value = txn.date || todayStr;
      state.monthInput.value = txn.month || guessBillingMonth(state.dateInput.value, currentSofIsCash());
      state.monthTouched = true; // editing an existing row -- don't override its saved month on open
      setToggle('txf-type-toggle', 'type', txn.type);
      setToggle('txf-status-toggle', 'status', txn.cleared === 'Cleared' ? 'Cleared' : 'Uncleared');
      state.deleteLink.style.display = 'block';
    } else {
      state.editingRow = null;
      state.sheetTitle.textContent = 'Add transaction';
      state.payeeEl.value = '';
      // Default the Source of Funds to whatever the host page says is
      // currently being viewed (e.g. the account detail screen on the
      // Accounts page), via the getDefaultSof() option -- applied here in
      // open() itself, not by a page-level click listener on the FAB, so it
      // covers every way an add-transaction sheet can be opened (FAB tap,
      // the "N" hardware-keyboard shortcut below, or any future trigger)
      // and every viewport uniformly. Falls back to leaving the field as-is
      // when the page doesn't supply one or has nothing to default to yet.
      const defaultSof = typeof state.options.getDefaultSof === 'function'
        ? state.options.getDefaultSof()
        : null;
      if (defaultSof) state.sofEl.value = defaultSof;
      state.amountInput.value = opts.prefillAmount != null
        ? formatAmountDisplay(digitsOnly(String(opts.prefillAmount)))
        : '';
      state.notesEl.value = '';
      state.dateInput.value = todayStr;
      state.monthInput.value = guessBillingMonth(todayStr, currentSofIsCash());
      setToggle('txf-type-toggle', 'type', 'Expense');
      // Default to Uncleared -- most transactions are logged before they've
      // actually posted/cleared on the account, so Uncleared is the more
      // accurate starting state. Cleared is still one tap away.
      setToggle('txf-status-toggle', 'status', 'Uncleared');
      state.deleteLink.style.display = 'none';
    }
    applyTypeMode();
    updateAmountColor();
    resizeAmountInput();

    // Autofocus the amount field for a new transaction so typing the amount
    // can start immediately -- but not when editing an existing one, where
    // jumping straight to the amount could be surprising / cause an
    // accidental edit before the rest of the fields have been reviewed
    // (Payee is focused instead). If the amount arrived pre-filled
    // (opts.prefillAmount), focus Payee next instead, since Amount is
    // already done. ModalA11y.open() applies this focus target, then keeps
    // Tab cycling within the sheet and wires Escape to close() -- see that
    // file's header comment.
    const focusTarget = isEditOpen
      ? state.payeeEl
      : (opts.prefillAmount != null ? state.payeeEl : state.amountInput);
    ModalA11y.open(state.overlay, { focus: focusTarget, onClose: close });
  }

  function close() {
    ModalA11y.close(state.overlay);
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
  // second, distinct-looking entry next to a cached "Alpha Cafe". Called
  // after both new-transaction and edit saves -- transactions-update.js
  // now also upserts the Payees registry (mirroring transactions-add.js),
  // so an edit that left the location-pin toggle on has a coordinate
  // update to splice into the cache too, same as a new transaction would.
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
    if (!isEdit && isTransferMode()) return handleTransferSave();
    if (isEdit && isTransferMode()) return handleConvertSave();

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

    // A captured position can be sent on either a new transaction or an
    // edit -- see requestLocation()/open(). Whether it actually overwrites
    // the payee's stored coordinate is entirely up to the location-pin
    // toggle's on/off state, same as before (see the toggle click handler
    // in mount() below); this just stops gating the whole thing on isEdit.
    if (state.capturedPosition && state.locationEnabled) {
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
      upsertLocalPayeeCache(payload.payee, payload.lat, payload.lon);
      renderPayeeOptions();
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

  // Issue #51: user confirms the flagged pair really is the same
  // transaction. In this MVP phase the server deletes the auto-imported
  // leg outright and clears the flag off the surviving manual row -- so the
  // row currently open in this form (which may itself be either leg) is
  // simply closed afterward rather than re-rendered in place.
  async function handleConfirmMatch() {
    if (!state.currentMatchId) return;
    const matchId = state.currentMatchId;
    try {
      const res = await fetch('/api/transactions-update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Mnab-Token': WRITE_TOKEN },
        body: JSON.stringify({ action: 'confirmMatch', matchId }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      close();
      showToast('Match confirmed');
      if (typeof state.options.onMatchResolved === 'function') state.options.onMatchResolved();
    } catch (err) {
      state.formError.textContent = err.message;
      state.formError.style.display = 'block';
    }
  }

  // Issue #51: user declines the proposed match -- clears the flag off both
  // rows (via their shared Match ID) and leaves each one otherwise
  // untouched, going back to being treated as fully independent.
  async function handleDeclineMatch() {
    if (!state.currentMatchId) return;
    const matchId = state.currentMatchId;
    try {
      const res = await fetch('/api/transactions-update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Mnab-Token': WRITE_TOKEN },
        body: JSON.stringify({ action: 'unmatchMatch', matchId }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      close();
      showToast('Unmatched');
      if (typeof state.options.onMatchResolved === 'function') state.options.onMatchResolved();
    } catch (err) {
      state.formError.textContent = err.message;
      state.formError.style.display = 'block';
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
      currentMatchId: null,
      monthTouched: false,
      capturedPosition: null,
      locationEnabled: false,
      accountsCache: [],
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
      matchBanner: rootEl.querySelector('#txf-match-banner'),
      matchConfirmBtn: rootEl.querySelector('#txf-match-confirm-btn'),
      matchDeclineBtn: rootEl.querySelector('#txf-match-decline-btn'),
      editingTxn: null,
      convertBaseType: 'Expense',
      candidates: [],
      linkRow: null,
      pairDeclined: new Set(),
      statementMonthApplied: false,
      monthBeforeStatement: '',
      pairBlock: rootEl.querySelector('#txf-pair-block'),
      pairTitle: rootEl.querySelector('#txf-pair-title'),
      pairList: rootEl.querySelector('#txf-pair-list'),
      billedEl: rootEl.querySelector('#txf-billed-check'),
      transferToLabel: rootEl.querySelector('#txf-to-label'),
      toMonthLabel: rootEl.querySelector('#txf-to-month-label'),
      transferBtn: rootEl.querySelector('#txf-type-transfer-btn'),
      payeeGroup: rootEl.querySelector('#txf-payee-group'),
      sofLabel: rootEl.querySelector('#txf-sof-label'),
      monthLabel: rootEl.querySelector('#txf-month-label'),
      transferToGroup: rootEl.querySelector('#txf-transfer-to-group'),
      transferToEl: rootEl.querySelector('#txf-f-to'),
      toMonthRow: rootEl.querySelector('#txf-to-month-row'),
      toMonthInput: rootEl.querySelector('#txf-f-to-month'),
      transferHintEl: rootEl.querySelector('#txf-transfer-hint'),
      toMonthTouched: false,
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
        const wasConvert = isConvertMode();
        setToggle('txf-type-toggle', 'type', b.dataset.type);
        // On Edit, Expense/Income decide which side of a conversion this
        // row is -- remember the last one picked before Transfer.
        if (b.dataset.type !== 'Transfer') state.convertBaseType = b.dataset.type;
        state.formError.style.display = 'none';
        applyTypeMode();
        updateAmountColor();
        if (isConvertMode() && !wasConvert) fetchCandidates();
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
      if (!state.monthTouched) state.monthInput.value = guessBillingMonth(state.dateInput.value, currentSofIsCash());
    });
    // Switching the account can flip which billing-month heuristic applies
    // (cash's 25th-cycle rule vs. a card's day-13 rule) -- re-guess from the
    // already-chosen date so the Month field doesn't keep a guess computed
    // for the previous account's rule.
    state.sofEl.addEventListener('change', () => {
      if (!state.monthTouched && state.dateInput.value) {
        state.monthInput.value = guessBillingMonth(state.dateInput.value, currentSofIsCash());
      }
      // The To list excludes whatever From now is (and drops the To pick if
      // it just became the From account).
      if (isTransferMode()) applyTypeMode();
    });

    state.transferToEl.addEventListener('change', () => {
      state.formError.style.display = 'none';
      if (isConvertMode()) {
        if (state.linkRow && state.linkRow.sof !== state.transferToEl.value) state.linkRow = null;
        refreshToMonthGuess();
        refreshConvertUI();
        return;
      }
      refreshToMonthGuess();
      updateTransferHint();
    });
    state.pairList.addEventListener('click', onPairClick);
    state.toMonthInput.addEventListener('input', () => { state.toMonthTouched = true; });
    state.dateInput.addEventListener('change', () => { if (isTransferMode()) refreshToMonthGuess(); });

    // Convert mode: the statement month follows the date until edited by
    // hand; amount/date edits re-query the other-half candidates and the
    // Diary statement check.
    state.monthInput.addEventListener('input', () => {
      if (state.statementMonthApplied) state.statementMonthTouched = true;
      if (isConvertMode()) refreshBilledCheck();
    });
    state.dateInput.addEventListener('change', () => {
      if (!isConvertMode()) return;
      if (state.statementMonthApplied && !state.statementMonthTouched) {
        state.monthInput.value = guessPaidStatementMonth(state.dateInput.value);
      }
      refreshConvertUI();
      scheduleCandidates();
    });
    state.amountInput.addEventListener('input', () => {
      if (!isConvertMode()) return;
      refreshBilledCheck();
      scheduleCandidates();
    });

    state.fab.addEventListener('click', () => open(null));
    state.sheetClose.addEventListener('click', close);
    state.overlay.addEventListener('click', (e) => { if (e.target === state.overlay) close(); });
    state.saveBtn.addEventListener('click', handleSave);
    state.deleteLink.addEventListener('click', handleDelete);
    state.matchConfirmBtn.addEventListener('click', handleConfirmMatch);
    state.matchDeclineBtn.addEventListener('click', handleDeclineMatch);

    // "N" hardware-keyboard shortcut (issue #60): pressing N opens Add
    // transaction, but only while focus isn't in a text field -- an on-screen
    // (soft) keyboard's key taps land on the focused input as normal
    // 'input'/'change' events, not as global 'keydown' events with a plain
    // key value, so this can't misfire while actually typing "n" into a
    // field on a phone. It's meant for an external/hardware keyboard where
    // nothing text-editable has focus. Skipped entirely on pages that hide
    // the FAB (showFab: false) and while the sheet is already open.
    document.addEventListener('keydown', (e) => {
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key !== 'n' && e.key !== 'N') return;
      if (state.fab.style.display === 'none') return;
      if (state.overlay.classList.contains('open')) return;
      const t = e.target;
      const tag = t && t.tagName;
      const isTextField = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable);
      if (isTextField) return;
      e.preventDefault();
      open(null);
    });

    loadAccounts();
    loadPayees();
  }

  global.TransactionForm = { mount, open, close, todayISO, guessBillingMonth, isCashAccountType };
})(window);
