/**
 * MNAB — Account Reconciliation macro (v3)
 * ------------------------------------------
 * Paste this into Extensions > Apps Script in your Google Sheet, save, then
 * reload the sheet. A new "Finances" menu will appear with
 * "Reconcile Account..." and "Undo Last Reconciliation...".
 *
 * Reconcile Account flow:
 *   1. One dialog: pick account from a dropdown, date defaults to today.
 *   2. Click "Calculate" -> shows the system total (sum of Cleared,
 *      not-yet-reconciled Total for that account since it was last
 *      reconciled) right there in the dialog.
 *   3. Type in the real statement/actual amount next to it.
 *   4. Click "Compare":
 *        - Match -> "Confirm & Reconcile" marks those transactions
 *          reconciled and logs the cycle.
 *        - Mismatch -> three options:
 *            "Back out" -- closes the dialog, nothing is written or
 *              logged, go fix the discrepancy yourself.
 *            "Add adjustment row" -- after a confirmation prompt (this is
 *              a one-way door short of a full Undo), writes one new
 *              "Reconciliation" transaction dated the as-of date for the
 *              delta -- Expense if the statement is higher than logged,
 *              Income if it's lower -- then marks the whole batch,
 *              including the new row, as reconciled.
 *            "Clear existing transactions" -- checklist of this account's
 *              uncleared transactions dated on or before the as-of date,
 *              for something that already cleared on the statement but
 *              never got flipped to Cleared here. Marks the checked rows
 *              Cleared, then recalculates and re-compares automatically.
 *            "Add transaction" -- inline form (name/type/date/amount,
 *              always Cleared) for something you forgot to log. Writes a
 *              normal transaction, then recalculates and re-compares
 *              automatically -- loop as many times as you need.
 *
 * Undo Last Reconciliation flow:
 *   Pick an account, see the details of its most recent completed
 *   reconciliation (Confirm & Reconcile or Add adjustment row -- backing
 *   out was never logged, so there's nothing to undo there), and undo it:
 *   un-reconciles the affected transactions, deletes the auto-inserted
 *   adjustment row if there was one, restores the Accounts tab's "Last
 *   Reconciled" fields to their prior value, and removes the log entry.
 *   Refuses if a newer reconciliation has happened since (for the same
 *   account) since undoing out of order isn't safe.
 *
 * Self-provisions on first run (no manual sheet surgery needed):
 *   - transactions tab: "Reconciled" and "Reconciled Date" columns
 *   - Accounts tab: "Last Reconciled Through" and
 *     "Last Reconciled Statement" columns
 *   - a new "Reconciliations" tab (structured audit log, one row per
 *     completed cycle -- backing out leaves no log entry by design)
 *
 * Column lookups are by header name, not fixed letters, so inserting or
 * reordering columns later won't break it. The transactions tab's payee
 * column is read as "Payee" if present, else "Name".
 */

const RECONCILE_CONFIG = {
  transactionsSheet: 'transactions',
  accountsSheet: 'Accounts',
  logSheet: 'Reconciliations',
};

// onOpen() is a simple trigger -- Apps Script only allows ONE function named
// onOpen per project, so this is the single place the whole "Finances" menu
// gets built, even for items whose logic lives in another file (e.g.
// addNextMonthRows() in Templates.gs). If you add more menu-driven scripts
// later, add their .addItem(...) call here rather than defining another
// onOpen().
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Finances')
    .addItem('Reconcile Account…', 'reconcileAccount')
    .addItem('Undo Last Reconciliation…', 'undoLastReconciliation')
    .addItem('Log Credit Card Payment…', 'logCreditCardPayment')
    .addItem("Add Next Month's Diary Rows…", 'addNextMonthRows')
    .addItem('Copy Installments & Bills to Transactions…', 'copyInstallmentsBillsToTransactions')
    .addItem('Set Up Daily Auto-Copy…', 'setupDailyTrigger')
    .addItem('Remove Daily Auto-Copy…', 'removeDailyTrigger')
    .addToUi();
}

/** Entry point wired to the menu item. */
function reconcileAccount() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const ui = SpreadsheetApp.getUi();

  const accountsSheet = ss.getSheetByName(RECONCILE_CONFIG.accountsSheet);
  if (!accountsSheet) {
    ui.alert(`Couldn't find a sheet named "${RECONCILE_CONFIG.accountsSheet}".`);
    return;
  }
  const accounts = getAccountRows(accountsSheet);
  if (!accounts.length) {
    ui.alert('No accounts found in the Accounts tab.');
    return;
  }

  const html = HtmlService.createHtmlOutput(buildDialogHtml(accounts))
    .setWidth(420)
    .setHeight(420);
  ui.showModalDialog(html, 'Reconcile Account');
}

/** Entry point wired to the "Undo Last Reconciliation…" menu item. */
function undoLastReconciliation() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const ui = SpreadsheetApp.getUi();

  const accountsSheet = ss.getSheetByName(RECONCILE_CONFIG.accountsSheet);
  if (!accountsSheet) {
    ui.alert(`Couldn't find a sheet named "${RECONCILE_CONFIG.accountsSheet}".`);
    return;
  }
  const accounts = getAccountRows(accountsSheet);
  if (!accounts.length) {
    ui.alert('No accounts found in the Accounts tab.');
    return;
  }

  const html = HtmlService.createHtmlOutput(buildUndoDialogHtml(accounts))
    .setWidth(420)
    .setHeight(380);
  ui.showModalDialog(html, 'Undo Last Reconciliation');
}

/* ---------------- dialog HTML ---------------- */

function buildDialogHtml(accounts) {
  const todayStr = formatDate(new Date());
  const accountsJson = JSON.stringify(
    accounts.map((a) => ({ name: a.name, type: a.type || '' }))
  );

  return `
<!DOCTYPE html>
<html>
<head>
<base target="_top">
<style>
  body { font-family: Arial, sans-serif; font-size: 13px; padding: 8px 4px; color: #202124; }
  label { display: block; margin: 12px 0 4px; font-weight: bold; }
  select, input[type=date], input[type=text] {
    width: 100%; padding: 6px; font-size: 13px; box-sizing: border-box;
  }
  button {
    margin-top: 10px; padding: 8px 14px; font-size: 13px; cursor: pointer;
    border-radius: 4px; border: 1px solid #ccc; background: #f1f3f4;
  }
  button.primary { background: #1a73e8; color: #fff; border-color: #1a73e8; }
  button.danger { background: #fff; color: #b3261e; border-color: #b3261e; }
  #result, #compareResult { margin-top: 14px; padding: 10px; border-radius: 6px; background: #f8f9fa; display: none; }
  #compareResult.match { background: #e6f4ea; }
  #compareResult.mismatch { background: #fce8e6; }
  .row { display: flex; justify-content: space-between; margin: 4px 0; }
  .muted { color: #5f6368; font-size: 12px; }
  .error { color: #b3261e; }
  #actions button { margin-right: 8px; }
  .clear-item { display: flex; align-items: center; gap: 8px; padding: 6px 0; border-bottom: 1px solid #e0e0e0; }
  .clear-item-main { flex: 1; }
  .clear-item-payee { font-weight: bold; }
  .clear-item-meta { color: #5f6368; font-size: 12px; }
  .clear-item-amount { font-weight: bold; }
  .clear-empty { color: #5f6368; font-size: 12px; padding: 6px 0; }
</style>
</head>
<body>

  <label for="account">Account</label>
  <select id="account">
    <option value="">-- choose --</option>
  </select>

  <label for="asOfDate">As-of / statement date</label>
  <input type="date" id="asOfDate" value="${todayStr}">

  <button id="calcBtn" class="primary" onclick="calculate()">Calculate system total</button>

  <div id="result"></div>

  <div id="amountBlock" style="display:none;">
    <label for="statementAmount" id="amountLabel">Statement / actual amount</label>
    <input type="text" id="statementAmount" placeholder="e.g. 5000000">
    <button class="primary" onclick="compare()">Compare</button>
  </div>

  <div id="compareResult"></div>
  <div id="actions" style="display:none;"></div>

  <div id="clearForm" style="display:none; margin-top:12px; padding:10px; border-radius:6px; background:#f1f3f4;">
    <p class="muted" style="margin-top:0;">Uncleared transactions on this account dated on or before the as-of date. Check the ones that actually cleared and forgot to be marked -- they'll be marked Cleared, then folded back into the recalculation.</p>
    <div id="clearList"></div>
    <div class="row" style="margin-top:8px;"><span>Selected total</span><b id="clearSelectedTotal">0</b></div>
    <button class="primary" id="clearSaveBtn" onclick="saveClearSelection()" disabled>Clear selected &amp; recalculate</button>
    <button onclick="hideClearForm()">Cancel</button>
  </div>

  <div id="addForm" style="display:none; margin-top:12px; padding:10px; border-radius:6px; background:#f1f3f4;">
    <label for="addName">Name</label>
    <input type="text" id="addName" placeholder="e.g. Grab to office">

    <label for="addType">Type</label>
    <select id="addType">
      <option value="Expense">Expense</option>
      <option value="Income">Income</option>
    </select>

    <label for="addDate">Date</label>
    <input type="date" id="addDate">

    <label for="addMonth">Billing month</label>
    <input type="month" id="addMonth">
    <p class="muted" style="margin-top:2px;">Defaults to a guess (day 1&ndash;12 of the month &rarr; that month, later &rarr; the next month) since statement cycles don't line up with calendar months &mdash; override if that's wrong for this one.</p>

    <label for="addAmount">Amount</label>
    <input type="text" id="addAmount" placeholder="e.g. 150000">

    <p class="muted">Always logged as Cleared for this account. It'll be picked up by the next recalculation.</p>

    <button class="primary" onclick="saveTransaction()">Save transaction</button>
    <button onclick="hideAddForm()">Cancel</button>
  </div>

<script>
  const accounts = ${accountsJson};
  const accountSelect = document.getElementById('account');
  accounts.forEach(a => {
    const opt = document.createElement('option');
    opt.value = a.name;
    opt.textContent = a.name + (a.type ? ' (' + a.type + ')' : '');
    accountSelect.appendChild(opt);
  });

  let lastCalc = null; // { account, asOfDate, sum, matchedCount, sinceDateLabel, sinceDateIso }
  let keepStatementAmount = false; // true while looping after an "Add transaction"

  function currentAccountType() {
    const a = accounts.find(x => x.name === accountSelect.value);
    return a ? a.type : '';
  }

  function calculate() {
    const account = accountSelect.value;
    const asOfDate = document.getElementById('asOfDate').value;
    const resultEl = document.getElementById('result');
    document.getElementById('compareResult').style.display = 'none';
    document.getElementById('actions').style.display = 'none';
    document.getElementById('actions').innerHTML = '';
    hideClearForm();

    if (!account) { alert('Pick an account first.'); return; }
    if (!asOfDate) { alert('Pick a date.'); return; }

    resultEl.style.display = 'block';
    resultEl.innerHTML = 'Calculating…';

    google.script.run
      .withSuccessHandler(function (r) {
        if (r.error) {
          resultEl.innerHTML = '<span class="error">' + r.error + '</span>';
          return;
        }
        lastCalc = {
          account: account,
          asOfDate: asOfDate,
          sum: r.sum,
          matchedCount: r.matchedCount,
          cumulativeSum: r.cumulativeSum,
          cumulativeCount: r.cumulativeCount,
          sinceDateLabel: r.sinceDateLabel,
          sinceDateIso: r.sinceDateIso,
        };
        resultEl.innerHTML =
          '<div class="row"><b>Book balance (through ' + asOfDate + ')</b><b>' + r.cumulativeSum.toLocaleString() + '</b></div>' +
          '<p class="muted" style="margin:2px 0 8px;">Every Cleared transaction on this account through this date, reconciled or not &mdash; compare this against what your bank/card statement shows.</p>' +
          '<div class="row"><span>New since ' + r.sinceDateLabel + '</span><span>' + r.matchedCount + ' txn(s)</span></div>';

        const amountBlock = document.getElementById('amountBlock');
        amountBlock.style.display = 'block';
        const isCredit = currentAccountType().toLowerCase().includes('credit');
        document.getElementById('amountLabel').textContent = isCredit
          ? 'New charges shown on the actual card statement for this cycle'
          : 'Actual total per your bank/cash records for this period';

        if (keepStatementAmount && document.getElementById('statementAmount').value.trim() !== '') {
          keepStatementAmount = false;
          compare();
        }
      })
      .withFailureHandler(function (err) {
        resultEl.innerHTML = '<span class="error">' + err.message + '</span>';
      })
      .rc_getSystemTotal(account, asOfDate);
  }

  function compare() {
    if (!lastCalc) return;
    const raw = document.getElementById('statementAmount').value;
    const statementAmount = Number(String(raw).replace(/[^0-9.-]/g, ''));
    if (isNaN(statementAmount) || raw.trim() === '') { alert("That doesn't look like a number."); return; }

    const variance = Math.round((statementAmount - lastCalc.cumulativeSum) * 100) / 100;
    const compareEl = document.getElementById('compareResult');
    const actionsEl = document.getElementById('actions');
    compareEl.style.display = 'block';
    actionsEl.style.display = 'block';
    actionsEl.innerHTML = '';

    if (variance === 0) {
      compareEl.className = 'match';
      compareEl.innerHTML = '<b>These match.</b> Ready to reconcile ' + lastCalc.matchedCount + ' transaction(s).';
      const btn = document.createElement('button');
      btn.className = 'primary';
      btn.textContent = 'Confirm & Reconcile';
      btn.onclick = function () { confirmReconcile(statementAmount); };
      actionsEl.appendChild(btn);
    } else {
      compareEl.className = 'mismatch';
      compareEl.innerHTML =
        '<b>These do not match.</b><br>' +
        '<div class="row"><span>Book balance</span><span>' + lastCalc.cumulativeSum.toLocaleString() + '</span></div>' +
        '<div class="row"><span>You entered</span><span>' + statementAmount.toLocaleString() + '</span></div>' +
        '<div class="row"><b>Variance</b><b>' + variance.toLocaleString() + '</b></div>' +
        '<p class="muted">Positive variance = statement is higher than what\\'s logged (something\\'s missing). Negative = statement is lower (over-logged or a refund).</p>';

      const backBtn = document.createElement('button');
      backBtn.className = 'danger';
      backBtn.textContent = 'Back out';
      backBtn.onclick = function () { google.script.host.close(); };
      actionsEl.appendChild(backBtn);

      const adjBtn = document.createElement('button');
      adjBtn.className = 'primary';
      adjBtn.textContent = 'Add adjustment row';
      adjBtn.onclick = function () { confirmInsertAdjustment(statementAmount, variance); };
      actionsEl.appendChild(adjBtn);

      const clearBtn = document.createElement('button');
      clearBtn.textContent = 'Clear existing transactions';
      clearBtn.onclick = function () { showClearForm(); };
      actionsEl.appendChild(clearBtn);

      const addBtn = document.createElement('button');
      addBtn.textContent = 'Add transaction';
      addBtn.onclick = function () { showAddForm(); };
      actionsEl.appendChild(addBtn);
    }
  }

  function confirmInsertAdjustment(statementAmount, variance) {
    const projType = variance > 0 ? 'Expense' : 'Income';
    const projAmount = Math.abs(variance);
    const proceed = confirm(
      'This will insert one new "Reconciliation" ' + projType + ' transaction for ' +
      projAmount.toLocaleString() + ' dated ' + lastCalc.asOfDate + ', and mark ' +
      (lastCalc.matchedCount + 1) + ' transaction(s) as reconciled.\\n\\n' +
      'You can undo this afterward via Finances > Undo Last Reconciliation, but only until ' +
      'this account is reconciled again. Continue?'
    );
    if (proceed) insertAdjustment(statementAmount);
  }

  // Rough default only -- statement cycles vary per account and there's no
  // firm cutoff, so this is a starting guess the "Billing month" field lets
  // you override, not an authoritative rule.
  function guessBillingMonth(dateStr) {
    const d = new Date(dateStr + 'T00:00:00');
    if (d.getDate() > 12) d.setMonth(d.getMonth() + 1);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  }

  let addMonthTouched = false;

  function showAddForm() {
    hideClearForm();
    document.getElementById('addName').value = '';
    document.getElementById('addAmount').value = '';
    document.getElementById('addType').value = 'Expense';
    document.getElementById('addDate').value = lastCalc.asOfDate;
    document.getElementById('addMonth').value = guessBillingMonth(lastCalc.asOfDate);
    addMonthTouched = false;
    document.getElementById('addForm').style.display = 'block';
  }

  document.getElementById('addMonth').addEventListener('input', () => { addMonthTouched = true; });
  document.getElementById('addDate').addEventListener('change', () => {
    if (!addMonthTouched) {
      document.getElementById('addMonth').value = guessBillingMonth(document.getElementById('addDate').value);
    }
  });

  function hideAddForm() {
    document.getElementById('addForm').style.display = 'none';
  }

  let clearSelection = new Set();
  let clearCandidates = [];

  function showClearForm() {
    document.getElementById('addForm').style.display = 'none';
    if (!lastCalc) return;

    const listEl = document.getElementById('clearList');
    listEl.innerHTML = 'Loading…';
    document.getElementById('clearForm').style.display = 'block';

    google.script.run
      .withSuccessHandler(function (r) {
        if (r.error) { listEl.innerHTML = '<span class="error">' + r.error + '</span>'; return; }
        clearCandidates = r.transactions;
        clearSelection = new Set();

        if (!clearCandidates.length) {
          listEl.innerHTML = '<div class="clear-empty">No uncleared transactions found on this account dated on or before ' + lastCalc.asOfDate + '.</div>';
        } else {
          listEl.innerHTML = clearCandidates.map(function (t) {
            const isIncome = t.type === 'Income';
            const amountText = (isIncome ? '+' : '') + t.amount.toLocaleString();
            return '<label class="clear-item">' +
              '<input type="checkbox" data-row="' + t.rowNumber + '" onchange="onClearItemToggle(' + t.rowNumber + ', this.checked)">' +
              '<div class="clear-item-main">' +
              '<div class="clear-item-payee">' + t.payee + '</div>' +
              '<div class="clear-item-meta">' + t.date + '</div>' +
              '</div>' +
              '<div class="clear-item-amount">' + amountText + '</div>' +
              '</label>';
          }).join('');
        }
        updateClearSelectionUI();
      })
      .withFailureHandler(function (err) {
        listEl.innerHTML = '<span class="error">' + err.message + '</span>';
      })
      .rc_getUnclearedTransactions(lastCalc.account, lastCalc.asOfDate);
  }

  function hideClearForm() {
    document.getElementById('clearForm').style.display = 'none';
  }

  function onClearItemToggle(rowNumber, checked) {
    if (checked) clearSelection.add(rowNumber);
    else clearSelection.delete(rowNumber);
    updateClearSelectionUI();
  }

  function updateClearSelectionUI() {
    const selected = clearCandidates.filter(function (t) { return clearSelection.has(t.rowNumber); });
    const total = selected.reduce(function (s, t) { return s + (t.type === 'Income' ? -t.amount : t.amount); }, 0);
    document.getElementById('clearSelectedTotal').textContent = total.toLocaleString();
    document.getElementById('clearSaveBtn').disabled = selected.length === 0;
  }

  function saveClearSelection() {
    const rowNumbers = Array.from(clearSelection);
    if (!rowNumbers.length) return;

    setBusy(true);
    google.script.run
      .withSuccessHandler(function (r) {
        setBusy(false);
        if (r.error) { alert(r.error); return; }
        hideClearForm();
        keepStatementAmount = true;
        calculate();
      })
      .withFailureHandler(function (err) { setBusy(false); alert(err.message); })
      .rc_clearTransactions(lastCalc.account, rowNumbers);
  }

  function saveTransaction() {
    if (!lastCalc) return;
    const name = document.getElementById('addName').value.trim();
    const type = document.getElementById('addType').value;
    const dateStr = document.getElementById('addDate').value;
    const monthStr = document.getElementById('addMonth').value;
    const rawAmount = document.getElementById('addAmount').value;
    const amount = Number(String(rawAmount).replace(/[^0-9.-]/g, ''));

    if (!name) { alert('Enter a name for the transaction.'); return; }
    if (!dateStr) { alert('Pick a date.'); return; }
    if (!monthStr) { alert('Pick a billing month.'); return; }
    if (isNaN(amount) || amount <= 0) { alert('Enter a positive amount.'); return; }

    const tooOld = lastCalc.sinceDateIso && dateStr <= lastCalc.sinceDateIso;
    const tooNew = dateStr > lastCalc.asOfDate;
    if (tooOld || tooNew) {
      const windowLabel = (lastCalc.sinceDateIso || '(beginning)') + ' \\u2192 ' + lastCalc.asOfDate;
      const proceed = confirm(
        'This date is outside the current reconciliation window (' + windowLabel + ').\\n\\n' +
        'Add it anyway?'
      );
      if (!proceed) return;
    }

    setBusy(true);
    google.script.run
      .withSuccessHandler(function (r) {
        setBusy(false);
        if (r.error) { alert(r.error); return; }
        hideAddForm();
        keepStatementAmount = true;
        calculate();
      })
      .withFailureHandler(function (err) { setBusy(false); alert(err.message); })
      .rc_addTransaction(lastCalc.account, name, type, dateStr, amount, monthStr);
  }

  function confirmReconcile(statementAmount) {
    setBusy(true);
    google.script.run
      .withSuccessHandler(function (r) {
        setBusy(false);
        if (r.error) { alert(r.error); return; }
        alert('Reconciled. ' + r.matchedCount + ' transaction(s) marked, Accounts tab updated.');
        google.script.host.close();
      })
      .withFailureHandler(function (err) { setBusy(false); alert(err.message); })
      .rc_confirmReconcile(lastCalc.account, lastCalc.asOfDate, statementAmount);
  }

  function insertAdjustment(statementAmount) {
    setBusy(true);
    google.script.run
      .withSuccessHandler(function (r) {
        setBusy(false);
        if (r.error) { alert(r.error); return; }
        alert('Inserted a Reconciliation ' + r.type + ' row for ' + r.amount.toLocaleString() +
          '. ' + r.matchedCount + ' transaction(s) total marked reconciled.');
        google.script.host.close();
      })
      .withFailureHandler(function (err) { setBusy(false); alert(err.message); })
      .rc_insertAdjustmentAndReconcile(lastCalc.account, lastCalc.asOfDate, statementAmount);
  }

  function setBusy(busy) {
    document.querySelectorAll('button').forEach(b => b.disabled = busy);
  }
</script>
</body>
</html>`;
}

function buildUndoDialogHtml(accounts) {
  const accountsJson = JSON.stringify(accounts.map((a) => ({ name: a.name, type: a.type || '' })));

  return `
<!DOCTYPE html>
<html>
<head>
<base target="_top">
<style>
  body { font-family: Arial, sans-serif; font-size: 13px; padding: 8px 4px; color: #202124; }
  label { display: block; margin: 12px 0 4px; font-weight: bold; }
  select { width: 100%; padding: 6px; font-size: 13px; box-sizing: border-box; }
  button {
    margin-top: 10px; padding: 8px 14px; font-size: 13px; cursor: pointer;
    border-radius: 4px; border: 1px solid #ccc; background: #f1f3f4;
  }
  button.primary { background: #1a73e8; color: #fff; border-color: #1a73e8; }
  button.danger { background: #fff; color: #b3261e; border-color: #b3261e; }
  #details { margin-top: 14px; padding: 10px; border-radius: 6px; background: #f8f9fa; display: none; }
  .row { display: flex; justify-content: space-between; margin: 4px 0; }
  .muted { color: #5f6368; font-size: 12px; }
  .error { color: #b3261e; }
  #actions button { margin-right: 8px; }
</style>
</head>
<body>

  <label for="account">Account</label>
  <select id="account">
    <option value="">-- choose --</option>
  </select>

  <button class="primary" onclick="lookUp()">Look up last reconciliation</button>

  <div id="details"></div>
  <div id="actions" style="display:none;"></div>

<script>
  const accounts = ${accountsJson};
  const accountSelect = document.getElementById('account');
  accounts.forEach(a => {
    const opt = document.createElement('option');
    opt.value = a.name;
    opt.textContent = a.name + (a.type ? ' (' + a.type + ')' : '');
    accountSelect.appendChild(opt);
  });

  function lookUp() {
    const account = accountSelect.value;
    const detailsEl = document.getElementById('details');
    const actionsEl = document.getElementById('actions');
    actionsEl.style.display = 'none';
    actionsEl.innerHTML = '';

    if (!account) { alert('Pick an account first.'); return; }

    detailsEl.style.display = 'block';
    detailsEl.innerHTML = 'Looking up…';

    google.script.run
      .withSuccessHandler(function (r) {
        if (r.error) {
          detailsEl.innerHTML = '<span class="error">' + r.error + '</span>';
          return;
        }
        if (!r.found) {
          detailsEl.innerHTML = '<span class="muted">No reconciliation history found for this account.</span>';
          return;
        }

        const adj = r.adjustmentType
          ? '<div class="row"><span>Adjustment row</span><span>' + r.adjustmentType + ' ' + r.adjustmentAmount.toLocaleString() + '</span></div>'
          : '';
        detailsEl.innerHTML =
          '<div class="row"><span>Period</span><span>' + r.periodStartLabel + ' &rarr; ' + r.periodEndLabel + '</span></div>' +
          '<div class="row"><span>System total</span><span>' + r.systemTotal.toLocaleString() + '</span></div>' +
          '<div class="row"><span>Statement amount</span><span>' + r.statementAmount.toLocaleString() + '</span></div>' +
          '<div class="row"><span>Variance</span><span>' + r.variance.toLocaleString() + '</span></div>' +
          '<div class="row"><span>Transactions marked reconciled</span><span>' + r.matchedCount.toLocaleString() + '</span></div>' +
          adj +
          '<div class="row"><span>Logged</span><span>' + r.timestampLabel + '</span></div>';

        if (!r.isCurrent) {
          detailsEl.innerHTML += '<p class="error">This account has been reconciled again since this entry -- undoing it now is not safe and is disabled.</p>';
          return;
        }

        const undoBtn = document.createElement('button');
        undoBtn.className = 'danger';
        undoBtn.textContent = 'Undo this reconciliation';
        undoBtn.onclick = function () { doUndo(account); };
        actionsEl.appendChild(undoBtn);
        actionsEl.style.display = 'block';
      })
      .withFailureHandler(function (err) {
        detailsEl.innerHTML = '<span class="error">' + err.message + '</span>';
      })
      .rc_getLastReconciliation(account);
  }

  function doUndo(account) {
    const proceed = confirm(
      'This will un-mark those transactions as reconciled, delete the auto-inserted adjustment row ' +
      '(if there was one), and restore the Accounts tab to its prior state. Continue?'
    );
    if (!proceed) return;

    document.querySelectorAll('button').forEach(b => b.disabled = true);
    google.script.run
      .withSuccessHandler(function (r) {
        document.querySelectorAll('button').forEach(b => b.disabled = false);
        if (r.error) { alert(r.error); return; }
        alert('Undone. ' + r.restoredCount + ' transaction(s) un-reconciled' +
          (r.deletedAdjustment ? ', adjustment row deleted' : '') + '.');
        google.script.host.close();
      })
      .withFailureHandler(function (err) {
        document.querySelectorAll('button').forEach(b => b.disabled = false);
        alert(err.message);
      })
      .rc_undoLastReconciliation(account);
  }
</script>
</body>
</html>`;
}

/* ---------------- server-side callables (invoked via google.script.run) ---------------- */

function rc_getSystemTotal(accountName, asOfDateStr) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const accountsSheet = ss.getSheetByName(RECONCILE_CONFIG.accountsSheet);
    const account = getAccountRows(accountsSheet).find(
      (a) => a.name.toLowerCase() === accountName.toLowerCase()
    );
    if (!account) return { error: `Account "${accountName}" not found.` };

    const asOfDate = parseISODate(asOfDateStr);
    if (!asOfDate) return { error: 'Invalid date.' };

    const sinceDate = account.lastReconciledThrough || new Date(0);
    const { matchedRows, sum } = sumClearedTransactions(ss, account.name, sinceDate, asOfDate);
    const { sum: cumulativeSum, count: cumulativeCount } = sumCumulativeClearedTransactions(
      ss,
      account.name,
      asOfDate
    );

    return {
      sum,
      matchedCount: matchedRows.length,
      cumulativeSum,
      cumulativeCount,
      sinceDateLabel: account.lastReconciledThrough ? formatDate(sinceDate) : '(beginning)',
      sinceDateIso: account.lastReconciledThrough ? formatDate(sinceDate) : null,
    };
  } catch (err) {
    return { error: err.message };
  }
}

/**
 * Adds one ordinary (non-adjustment) transaction for the account being
 * reconciled -- e.g. something you forgot to log. Left un-reconciled on
 * purpose: it becomes just another row that the next sumClearedTransactions
 * call picks up like any other, so it flows through the normal
 * confirm/adjust path rather than needing special-cased logic.
 */
function rc_addTransaction(accountName, name, type, dateStr, amount, monthStr) {
  try {
    if (!name || !String(name).trim()) return { error: 'Name is required.' };
    const numAmount = Number(amount);
    if (isNaN(numAmount) || numAmount <= 0) return { error: 'Amount must be a positive number.' };
    if (type !== 'Expense' && type !== 'Income') return { error: 'Type must be Expense or Income.' };
    const date = parseISODate(dateStr);
    if (!date) return { error: 'Invalid date.' };
    // monthStr ("YYYY-MM") comes from the dialog's editable "Billing month"
    // field -- falls back to the day-of-month guess if it's missing for any
    // reason, but the field should always be filled in by the client.
    const month = monthStr ? parseISOMonth(monthStr) : billingMonthForDate(date);
    if (!month) return { error: 'Invalid billing month.' };

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const txnSheet = ss.getSheetByName(RECONCILE_CONFIG.transactionsSheet);
    if (!txnSheet) return { error: `Couldn't find sheet "${RECONCILE_CONFIG.transactionsSheet}"` };
    ensureColumn(txnSheet, 'Reconciled');
    ensureColumn(txnSheet, 'Reconciled Date');
    const colIndex = headerIndexMap(txnSheet);

    appendPlainTransactionRow(txnSheet, colIndex, {
      name: String(name).trim(),
      sof: accountName,
      type,
      amount: numAmount,
      date,
      month,
    });

    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
}

/**
 * Lists uncleared transactions on the account being reconciled, dated on or
 * before the as-of date -- candidates for the "Clear existing transactions"
 * option, for something that actually cleared on the statement but never
 * got flipped to Cleared here (mirrors the mobile app's rcShowClearForm).
 */
function rc_getUnclearedTransactions(accountName, asOfDateStr) {
  try {
    const asOfDate = parseISODate(asOfDateStr);
    if (!asOfDate) return { error: 'Invalid date.' };

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const txnSheet = ss.getSheetByName(RECONCILE_CONFIG.transactionsSheet);
    if (!txnSheet) return { error: `Couldn't find sheet "${RECONCILE_CONFIG.transactionsSheet}"` };

    const colIndex = headerIndexMap(txnSheet);
    ['SOF', 'Date', 'Cleared'].forEach((h) => {
      if (!(h in colIndex)) throw new Error(`transactions tab is missing a "${h}" column.`);
    });
    const amountHeader = 'Total' in colIndex ? 'Total' : 'Amount';
    const payeeHeader = payeeHeaderName(colIndex);

    const lastRow = txnSheet.getLastRow();
    if (lastRow < 2) return { transactions: [] };
    const values = txnSheet.getRange(2, 1, lastRow - 1, txnSheet.getLastColumn()).getValues();

    const transactions = [];
    values.forEach((row, i) => {
      const sof = row[colIndex['SOF']];
      if (!sof || String(sof).trim().toLowerCase() !== accountName.toLowerCase()) return;

      const cleared = String(row[colIndex['Cleared']] || '').trim().toLowerCase();
      if (cleared === 'cleared') return; // only uncleared rows are candidates

      const date = row[colIndex['Date']];
      if (!(date instanceof Date)) return;
      if (date > asOfDate) return; // belongs to a future cycle

      transactions.push({
        rowNumber: i + 2, // 1-based sheet row
        payee: payeeHeader ? String(row[colIndex[payeeHeader]] || '').trim() : '',
        date: formatDate(date),
        type: colIndex['Income/Expense'] !== undefined ? row[colIndex['Income/Expense']] : '',
        amount: amountHeader in colIndex ? Number(row[colIndex[amountHeader]]) || 0 : 0,
      });
    });

    return { transactions };
  } catch (err) {
    return { error: err.message };
  }
}

/**
 * Marks the given rows Cleared for the given account -- used when the
 * statement shows a transaction that was logged here but never flipped to
 * Cleared. Re-validates against the current sheet state rather than
 * trusting the client's cached list, same as the mobile app's
 * actionClearTransactions: guards against a row that was edited, deleted,
 * or already cleared elsewhere since the dialog's list was fetched, and
 * against clearing a wrong-account row by mistake.
 */
function rc_clearTransactions(accountName, rowNumbers) {
  try {
    const cleanRowNumbers = Array.from(
      new Set((rowNumbers || []).map((n) => Number(n)))
    ).filter((n) => Number.isInteger(n) && n > 1);
    if (!cleanRowNumbers.length) return { error: 'Select at least one transaction to clear.' };

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const txnSheet = ss.getSheetByName(RECONCILE_CONFIG.transactionsSheet);
    if (!txnSheet) return { error: `Couldn't find sheet "${RECONCILE_CONFIG.transactionsSheet}"` };

    const colIndex = headerIndexMap(txnSheet);
    ['SOF', 'Cleared'].forEach((h) => {
      if (!(h in colIndex)) throw new Error(`transactions tab is missing a "${h}" column.`);
    });

    const lastRow = txnSheet.getLastRow();
    const badRow = cleanRowNumbers.find((r) => {
      if (r > lastRow) return true;
      const rowValues = txnSheet.getRange(r, 1, 1, txnSheet.getLastColumn()).getValues()[0];
      const sof = rowValues[colIndex['SOF']];
      const cleared = String(rowValues[colIndex['Cleared']] || '').trim().toLowerCase();
      return !sof || String(sof).trim().toLowerCase() !== accountName.toLowerCase() || cleared === 'cleared';
    });
    if (badRow !== undefined) {
      return { error: 'One or more selected transactions are no longer uncleared on this account -- refresh and try again.' };
    }

    cleanRowNumbers.forEach((r) => {
      txnSheet.getRange(r, colIndex['Cleared'] + 1).setValue('Cleared');
    });

    return { ok: true, clearedCount: cleanRowNumbers.length };
  } catch (err) {
    return { error: err.message };
  }
}

function rc_confirmReconcile(accountName, asOfDateStr, statementAmount) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const accountsSheet = ss.getSheetByName(RECONCILE_CONFIG.accountsSheet);
    const account = getAccountRows(accountsSheet).find(
      (a) => a.name.toLowerCase() === accountName.toLowerCase()
    );
    if (!account) return { error: `Account "${accountName}" not found.` };

    const asOfDate = parseISODate(asOfDateStr);
    const sinceDate = account.lastReconciledThrough || new Date(0);
    const { matchedRows, txnSheet, colIndex } = sumClearedTransactions(
      ss,
      account.name,
      sinceDate,
      asOfDate
    );
    const { sum: cumulativeSum } = sumCumulativeClearedTransactions(ss, account.name, asOfDate);

    markRowsReconciled(txnSheet, colIndex, matchedRows, asOfDate);
    updateAccountLastReconciled(accountsSheet, account.rowIndex, asOfDate, statementAmount);
    logReconciliation(ss, {
      account: account.name,
      periodStart: sinceDate,
      periodEnd: asOfDate,
      systemTotal: cumulativeSum,
      statementAmount,
      variance: round2(statementAmount - cumulativeSum),
      matchedCount: matchedRows.length,
      adjustmentType: null,
      adjustmentAmount: null,
      status: 'Reconciled',
    });

    return { matchedCount: matchedRows.length };
  } catch (err) {
    return { error: err.message };
  }
}

function rc_insertAdjustmentAndReconcile(accountName, asOfDateStr, statementAmount) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const accountsSheet = ss.getSheetByName(RECONCILE_CONFIG.accountsSheet);
    const account = getAccountRows(accountsSheet).find(
      (a) => a.name.toLowerCase() === accountName.toLowerCase()
    );
    if (!account) return { error: `Account "${accountName}" not found.` };

    const asOfDate = parseISODate(asOfDateStr);
    const sinceDate = account.lastReconciledThrough || new Date(0);
    const { matchedRows, txnSheet, colIndex } = sumClearedTransactions(
      ss,
      account.name,
      sinceDate,
      asOfDate
    );
    const { sum: cumulativeSum } = sumCumulativeClearedTransactions(ss, account.name, asOfDate);

    const delta = round2(statementAmount - cumulativeSum);
    if (delta === 0) {
      // Nothing to adjust -- just reconcile the existing rows.
      markRowsReconciled(txnSheet, colIndex, matchedRows, asOfDate);
      updateAccountLastReconciled(accountsSheet, account.rowIndex, asOfDate, statementAmount);
      logReconciliation(ss, {
        account: account.name,
        periodStart: sinceDate,
        periodEnd: asOfDate,
        systemTotal: cumulativeSum,
        statementAmount,
        variance: 0,
        matchedCount: matchedRows.length,
        adjustmentType: null,
        adjustmentAmount: null,
        status: 'Reconciled',
      });
      return { matchedCount: matchedRows.length, amount: 0, type: 'none' };
    }

    // Positive delta: statement is higher than logged -> add an Expense.
    // Negative delta: statement is lower than logged -> add an Income
    // (nets against Expense via the Total column, per how this sheet works).
    const type = delta > 0 ? 'Expense' : 'Income';
    const amount = Math.abs(delta);
    const newRowNumber = appendAdjustmentRow(txnSheet, colIndex, {
      account: account.name,
      type,
      amount,
      date: asOfDate,
    });

    const allRows = matchedRows.concat([newRowNumber]);
    markRowsReconciled(txnSheet, colIndex, allRows, asOfDate);
    updateAccountLastReconciled(accountsSheet, account.rowIndex, asOfDate, statementAmount);
    logReconciliation(ss, {
      account: account.name,
      periodStart: sinceDate,
      periodEnd: asOfDate,
      systemTotal: cumulativeSum,
      statementAmount,
      variance: delta,
      matchedCount: allRows.length,
      adjustmentType: type,
      adjustmentAmount: amount,
      status: 'Reconciled via adjustment',
    });

    return { matchedCount: allRows.length, amount, type };
  } catch (err) {
    return { error: err.message };
  }
}

function rc_getLastReconciliation(accountName) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const accountsSheet = ss.getSheetByName(RECONCILE_CONFIG.accountsSheet);
    const account = getAccountRows(accountsSheet).find(
      (a) => a.name.toLowerCase() === accountName.toLowerCase()
    );
    if (!account) return { error: `Account "${accountName}" not found.` };

    const { rows } = getReconciliationLogRows(ss, account.name);
    if (!rows.length) return { found: false };

    const entry = rows[rows.length - 1];
    const isCurrent =
      account.lastReconciledThrough &&
      formatDate(account.lastReconciledThrough) === formatDate(entry.periodEnd);

    return {
      found: true,
      periodStartLabel:
        entry.periodStart instanceof Date && entry.periodStart.getTime() > 0
          ? formatDate(entry.periodStart)
          : '(beginning)',
      periodEndLabel: formatDate(entry.periodEnd),
      systemTotal: entry.systemTotal,
      statementAmount: entry.statementAmount,
      variance: entry.variance,
      matchedCount: entry.matchedCount,
      adjustmentType: entry.adjustmentType,
      adjustmentAmount: entry.adjustmentAmount,
      timestampLabel: entry.timestamp instanceof Date ? entry.timestamp.toLocaleString() : String(entry.timestamp),
      isCurrent: !!isCurrent,
    };
  } catch (err) {
    return { error: err.message };
  }
}

/**
 * Reverses the most recent completed reconciliation (Confirm & Reconcile or
 * Add adjustment row) for an account. Refuses if a newer reconciliation has
 * happened since -- at that point the transaction set has moved on and
 * undoing the older cycle isn't well-defined.
 */
function rc_undoLastReconciliation(accountName) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const accountsSheet = ss.getSheetByName(RECONCILE_CONFIG.accountsSheet);
    const account = getAccountRows(accountsSheet).find(
      (a) => a.name.toLowerCase() === accountName.toLowerCase()
    );
    if (!account) return { error: `Account "${accountName}" not found.` };

    const { logSheet, rows } = getReconciliationLogRows(ss, account.name);
    if (!rows.length) return { error: 'No reconciliation history found for this account.' };

    const entry = rows[rows.length - 1];
    const previousEntry = rows.length > 1 ? rows[rows.length - 2] : null;

    if (
      !account.lastReconciledThrough ||
      formatDate(account.lastReconciledThrough) !== formatDate(entry.periodEnd)
    ) {
      return {
        error:
          'This account has been reconciled again since this entry -- undoing it now is not safe.',
      };
    }

    const txnSheet = ss.getSheetByName(RECONCILE_CONFIG.transactionsSheet);
    if (!txnSheet) return { error: `Couldn't find sheet "${RECONCILE_CONFIG.transactionsSheet}"` };
    const colIndex = headerIndexMap(txnSheet);
    ['SOF', 'Date', 'Reconciled', 'Reconciled Date'].forEach((h) => {
      if (!(h in colIndex)) throw new Error(`transactions tab is missing a "${h}" column.`);
    });

    const periodEndLabel = formatDate(entry.periodEnd);
    const payeeHeader = payeeHeaderName(colIndex);
    const lastRow = txnSheet.getLastRow();
    const values = lastRow >= 2 ? txnSheet.getRange(2, 1, lastRow - 1, txnSheet.getLastColumn()).getValues() : [];

    let restoredCount = 0;
    let adjustmentRowNumber = null;

    values.forEach((row, i) => {
      const sof = row[colIndex['SOF']];
      if (!sof || String(sof).trim().toLowerCase() !== account.name.toLowerCase()) return;
      const reconciledDate = row[colIndex['Reconciled Date']];
      if (!(reconciledDate instanceof Date) || formatDate(reconciledDate) !== periodEndLabel) return;
      if (row[colIndex['Reconciled']] !== true) return;

      const rowNumber = i + 2;
      const isAdjustmentRow =
        entry.adjustmentType &&
        payeeHeader &&
        String(row[colIndex[payeeHeader]]).trim() === 'Reconciliation' &&
        'Notes' in colIndex &&
        String(row[colIndex['Notes']]).trim() === 'Auto-inserted to reconcile against statement';

      if (isAdjustmentRow && adjustmentRowNumber === null) {
        adjustmentRowNumber = rowNumber; // delete last, after everything else is processed
      } else {
        txnSheet.getRange(rowNumber, colIndex['Reconciled'] + 1).setValue(false);
        txnSheet.getRange(rowNumber, colIndex['Reconciled Date'] + 1).setValue('');
        restoredCount++;
      }
    });

    let deletedAdjustment = false;
    if (adjustmentRowNumber !== null) {
      txnSheet.deleteRow(adjustmentRowNumber);
      deletedAdjustment = true;
    }

    if (previousEntry) {
      updateAccountLastReconciled(accountsSheet, account.rowIndex, previousEntry.periodEnd, previousEntry.statementAmount);
    } else {
      const map = headerIndexMap(accountsSheet);
      accountsSheet.getRange(account.rowIndex, map['Last Reconciled Through'] + 1).setValue('');
      accountsSheet.getRange(account.rowIndex, map['Last Reconciled Statement'] + 1).setValue('');
    }

    logSheet.deleteRow(entry.rowNumber);

    return { restoredCount, deletedAdjustment };
  } catch (err) {
    return { error: err.message };
  }
}

/* ---------------- helpers ---------------- */

function headerIndexMap(sheet) {
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const map = {};
  headers.forEach((h, i) => {
    if (h) map[String(h).trim()] = i; // 0-based column index
  });
  return map;
}

function ensureColumn(sheet, headerName) {
  const map = headerIndexMap(sheet);
  if (headerName in map) return map[headerName];
  const col = sheet.getLastColumn() + 1;
  sheet.getRange(1, col).setValue(headerName);
  return col - 1; // 0-based
}

function getAccountRows(accountsSheet) {
  const lastReconciledThroughCol = ensureColumn(accountsSheet, 'Last Reconciled Through');
  ensureColumn(accountsSheet, 'Last Reconciled Statement');
  const map = headerIndexMap(accountsSheet);
  const lastRow = accountsSheet.getLastRow();
  if (lastRow < 2) return [];
  const values = accountsSheet.getRange(2, 1, lastRow - 1, accountsSheet.getLastColumn()).getValues();

  return values
    .map((row, i) => {
      const name = row[map['Name']];
      if (!name) return null;
      const rawDate = row[lastReconciledThroughCol];
      return {
        name: String(name).trim(),
        type: map['Type'] !== undefined ? row[map['Type']] : '',
        lastReconciledThrough: rawDate instanceof Date ? rawDate : null,
        rowIndex: i + 2, // 1-based sheet row
      };
    })
    .filter(Boolean);
}

function payeeHeaderName(colIndex) {
  if ('Payee' in colIndex) return 'Payee';
  if ('Name' in colIndex) return 'Name';
  return null;
}

function sumClearedTransactions(ss, accountName, sinceDate, asOfDate) {
  const txnSheet = ss.getSheetByName(RECONCILE_CONFIG.transactionsSheet);
  if (!txnSheet) throw new Error(`Couldn't find sheet "${RECONCILE_CONFIG.transactionsSheet}"`);

  ensureColumn(txnSheet, 'Reconciled');
  ensureColumn(txnSheet, 'Reconciled Date');
  const colIndex = headerIndexMap(txnSheet);

  ['SOF', 'Date', 'Cleared'].forEach((h) => {
    if (!(h in colIndex)) throw new Error(`transactions tab is missing a "${h}" column.`);
  });
  // Prefer the net "Total" column (Expense - Income) so refunds logged as
  // Income correctly reduce the total; fall back to "Amount" if this sheet
  // doesn't have a Total column.
  const amountHeader = 'Total' in colIndex ? 'Total' : 'Amount';
  if (!(amountHeader in colIndex)) throw new Error('transactions tab needs a "Total" or "Amount" column.');

  const lastRow = txnSheet.getLastRow();
  if (lastRow < 2) return { matchedRows: [], sum: 0, txnSheet, colIndex };
  const values = txnSheet.getRange(2, 1, lastRow - 1, txnSheet.getLastColumn()).getValues();

  let sum = 0;
  const matchedRows = [];

  values.forEach((row, i) => {
    const sof = row[colIndex['SOF']];
    if (!sof || String(sof).trim().toLowerCase() !== accountName.toLowerCase()) return;

    const cleared = String(row[colIndex['Cleared']] || '').trim().toLowerCase();
    if (cleared !== 'cleared') return; // only settled transactions count toward a statement

    const alreadyReconciled = row[colIndex['Reconciled']] === true;
    if (alreadyReconciled) return;

    const date = row[colIndex['Date']];
    if (!(date instanceof Date)) return;
    if (date <= sinceDate) return; // already covered by a previous reconciliation
    if (date > asOfDate) return; // belongs to a future cycle

    const amount = Number(row[colIndex[amountHeader]]) || 0;
    sum += amount;
    matchedRows.push(i + 2); // 1-based sheet row
  });

  return { matchedRows, sum: round2(sum), txnSheet, colIndex };
}

/**
 * The "book balance" for an account: sum of Total for every Cleared
 * transaction on that account with Date <= asOfDate, regardless of whether
 * it's already been reconciled. This is the number that lines up with what
 * a bank/card statement actually shows -- statements don't know or care
 * about this sheet's internal "Reconciled" bookkeeping flag, they just show
 * the running balance of everything that's cleared. Used as the primary
 * comparison figure; sumClearedTransactions()'s incremental, unreconciled-
 * only figure remains what actually drives which rows get marked
 * Reconciled=true.
 */
function sumCumulativeClearedTransactions(ss, accountName, asOfDate) {
  const txnSheet = ss.getSheetByName(RECONCILE_CONFIG.transactionsSheet);
  if (!txnSheet) throw new Error(`Couldn't find sheet "${RECONCILE_CONFIG.transactionsSheet}"`);

  const colIndex = headerIndexMap(txnSheet);
  ['SOF', 'Date', 'Cleared'].forEach((h) => {
    if (!(h in colIndex)) throw new Error(`transactions tab is missing a "${h}" column.`);
  });
  const amountHeader = 'Total' in colIndex ? 'Total' : 'Amount';
  if (!(amountHeader in colIndex)) throw new Error('transactions tab needs a "Total" or "Amount" column.');

  const lastRow = txnSheet.getLastRow();
  if (lastRow < 2) return { sum: 0, count: 0 };
  const values = txnSheet.getRange(2, 1, lastRow - 1, txnSheet.getLastColumn()).getValues();

  let sum = 0;
  let count = 0;

  values.forEach((row) => {
    const sof = row[colIndex['SOF']];
    if (!sof || String(sof).trim().toLowerCase() !== accountName.toLowerCase()) return;

    const cleared = String(row[colIndex['Cleared']] || '').trim().toLowerCase();
    if (cleared !== 'cleared') return;

    const date = row[colIndex['Date']];
    if (!(date instanceof Date)) return;
    if (date > asOfDate) return; // belongs to a future cycle

    const amount = Number(row[colIndex[amountHeader]]) || 0;
    sum += amount;
    count++;
  });

  return { sum: round2(sum), count };
}

function markRowsReconciled(txnSheet, colIndex, rowNumbers, asOfDate) {
  rowNumbers.forEach((r) => {
    txnSheet.getRange(r, colIndex['Reconciled'] + 1).setValue(true);
    txnSheet.getRange(r, colIndex['Reconciled Date'] + 1).setValue(asOfDate);
  });
}

function appendAdjustmentRow(txnSheet, colIndex, { account, type, amount, date }) {
  const rowNumber = txnSheet.getLastRow() + 1;
  const width = txnSheet.getLastColumn();
  const row = new Array(width).fill('');

  const payeeHeader = payeeHeaderName(colIndex);
  if (payeeHeader) row[colIndex[payeeHeader]] = 'Reconciliation';
  if ('Income/Expense' in colIndex) row[colIndex['Income/Expense']] = type;
  if ('SOF' in colIndex) row[colIndex['SOF']] = account;
  if ('Date' in colIndex) row[colIndex['Date']] = date;
  // No dedicated field for this on the auto-inserted adjustment row (it's
  // not driven by the "Add transaction" form), so fall back to the same
  // day-of-month guess used there.
  if ('Month' in colIndex) row[colIndex['Month']] = billingMonthForDate(date);
  if ('Cleared' in colIndex) row[colIndex['Cleared']] = 'Cleared';
  if ('Amount' in colIndex) row[colIndex['Amount']] = amount;
  const expense = type === 'Expense' ? amount : 0;
  const income = type === 'Income' ? amount : 0;
  if ('Expense' in colIndex) row[colIndex['Expense']] = expense;
  if ('Income' in colIndex) row[colIndex['Income']] = income;
  if ('Total' in colIndex) row[colIndex['Total']] = expense - income;
  if ('Notes' in colIndex) row[colIndex['Notes']] = 'Auto-inserted to reconcile against statement';

  txnSheet.getRange(rowNumber, 1, 1, width).setValues([row]);
  return rowNumber;
}

/**
 * Appends a plain, un-reconciled, Cleared transaction -- used when the user
 * fills in the "Add transaction" form for something missing from the sheet.
 * Unlike appendAdjustmentRow, this is a real transaction with a real name,
 * not a synthetic "Reconciliation" plug row.
 */
function appendPlainTransactionRow(txnSheet, colIndex, { name, sof, type, amount, date, month }) {
  const rowNumber = txnSheet.getLastRow() + 1;
  const width = txnSheet.getLastColumn();
  const row = new Array(width).fill('');

  const payeeHeader = payeeHeaderName(colIndex);
  if (payeeHeader) row[colIndex[payeeHeader]] = name;
  if ('Income/Expense' in colIndex) row[colIndex['Income/Expense']] = type;
  if ('SOF' in colIndex) row[colIndex['SOF']] = sof;
  if ('Date' in colIndex) row[colIndex['Date']] = date;
  // Passed in explicitly from the dialog's editable "Billing month" field
  // (falls back to the day-of-month guess server-side if it's ever missing)
  // -- statement cycles don't line up with calendar months, so this should
  // not just be derived from Date.
  if ('Month' in colIndex) row[colIndex['Month']] = month || billingMonthForDate(date);
  if ('Cleared' in colIndex) row[colIndex['Cleared']] = 'Cleared';
  if ('Amount' in colIndex) row[colIndex['Amount']] = amount;
  const expense = type === 'Expense' ? amount : 0;
  const income = type === 'Income' ? amount : 0;
  if ('Expense' in colIndex) row[colIndex['Expense']] = expense;
  if ('Income' in colIndex) row[colIndex['Income']] = income;
  if ('Total' in colIndex) row[colIndex['Total']] = expense - income;
  if ('Notes' in colIndex) row[colIndex['Notes']] = 'Added during reconciliation';
  // Reconciled / Reconciled Date deliberately left blank -- this row flows
  // through the normal matching logic on the next recalculation, same as
  // any pre-existing transaction.

  txnSheet.getRange(rowNumber, 1, 1, width).setValues([row]);
  return rowNumber;
}

function updateAccountLastReconciled(accountsSheet, rowIndex, asOfDate, statementAmount) {
  const map = headerIndexMap(accountsSheet);
  accountsSheet.getRange(rowIndex, map['Last Reconciled Through'] + 1).setValue(asOfDate);
  accountsSheet.getRange(rowIndex, map['Last Reconciled Statement'] + 1).setValue(statementAmount);
}

// Column order for the Reconciliations log tab. "Matched Count" and the two
// "Adjustment ..." columns are read back by rc_undoLastReconciliation, so
// they're kept as real columns rather than folded into the free-text
// "Status" -- makes undo a lookup instead of a string-parsing exercise.
const RECONCILIATION_LOG_COLUMNS = [
  'Timestamp',
  'Account',
  'Period Start',
  'Period End',
  'System Total',
  'Statement Amount',
  'Variance',
  'Matched Count',
  'Adjustment Type',
  'Adjustment Amount',
  'Status',
];

function getOrCreateLogSheet(ss) {
  let logSheet = ss.getSheetByName(RECONCILE_CONFIG.logSheet);
  if (!logSheet) {
    logSheet = ss.insertSheet(RECONCILE_CONFIG.logSheet);
  }
  RECONCILIATION_LOG_COLUMNS.forEach((c) => ensureColumn(logSheet, c));
  return logSheet;
}

/**
 * entry: { account, periodStart, periodEnd, systemTotal, statementAmount,
 *          variance, matchedCount, adjustmentType (or null), adjustmentAmount
 *          (or null), status }
 * Returns the 1-based row number the entry was written to.
 */
function logReconciliation(ss, entry) {
  const logSheet = getOrCreateLogSheet(ss);
  const colIndex = headerIndexMap(logSheet);
  const rowNumber = logSheet.getLastRow() + 1;
  const width = logSheet.getLastColumn();
  const row = new Array(width).fill('');

  row[colIndex['Timestamp']] = new Date();
  row[colIndex['Account']] = entry.account;
  row[colIndex['Period Start']] = entry.periodStart;
  row[colIndex['Period End']] = entry.periodEnd;
  row[colIndex['System Total']] = entry.systemTotal;
  row[colIndex['Statement Amount']] = entry.statementAmount;
  row[colIndex['Variance']] = entry.variance;
  row[colIndex['Matched Count']] = entry.matchedCount;
  row[colIndex['Adjustment Type']] = entry.adjustmentType || '';
  row[colIndex['Adjustment Amount']] = entry.adjustmentAmount || '';
  row[colIndex['Status']] = entry.status;

  logSheet.getRange(rowNumber, 1, 1, width).setValues([row]);
  return rowNumber;
}

/** All log rows for one account, in sheet order (oldest first). */
function getReconciliationLogRows(ss, accountName) {
  const logSheet = ss.getSheetByName(RECONCILE_CONFIG.logSheet);
  if (!logSheet) return { logSheet: null, colIndex: null, rows: [] };

  const colIndex = headerIndexMap(logSheet);
  const lastRow = logSheet.getLastRow();
  if (lastRow < 2) return { logSheet, colIndex, rows: [] };

  const values = logSheet.getRange(2, 1, lastRow - 1, logSheet.getLastColumn()).getValues();
  const rows = [];
  values.forEach((row, i) => {
    const account = row[colIndex['Account']];
    if (!account || String(account).trim().toLowerCase() !== accountName.toLowerCase()) return;
    rows.push({
      rowNumber: i + 2,
      timestamp: row[colIndex['Timestamp']],
      account: String(account).trim(),
      periodStart: row[colIndex['Period Start']],
      periodEnd: row[colIndex['Period End']],
      systemTotal: row[colIndex['System Total']],
      statementAmount: row[colIndex['Statement Amount']],
      variance: row[colIndex['Variance']],
      matchedCount: row[colIndex['Matched Count']],
      adjustmentType: row[colIndex['Adjustment Type']] || '',
      adjustmentAmount: row[colIndex['Adjustment Amount']] || 0,
      status: row[colIndex['Status']],
    });
  });
  return { logSheet, colIndex, rows };
}

function parseISODate(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(text).trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return isNaN(d.getTime()) ? null : d;
}

function firstOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

/**
 * Rough default for which billing month a transaction belongs to: dates
 * early in the month (day <= 12) stay in that calendar month; later dates
 * roll into the next one. This is a starting guess, not a firm rule --
 * statement cycles vary per account/card and don't line up with calendar
 * months. Used only as a fallback / seed value; the "Add transaction" form
 * exposes an editable field so it can be corrected per row.
 */
function billingMonthForDate(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  if (d.getDate() > 12) d.setMonth(d.getMonth() + 1);
  return firstOfMonth(d);
}

function parseISOMonth(text) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(text).trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, 1);
  return isNaN(d.getTime()) ? null : d;
}

function formatDate(d) {
  return Utilities.formatDate(d, Session.getScriptTimeZone() || 'UTC', 'yyyy-MM-dd');
}

function round2(n) {
  return Math.round(n * 100) / 100;
}
