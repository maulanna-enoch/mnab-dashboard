/**
 * InboxImport.gs — "Import Approved Rows from Inbox…"
 *
 * Moves reviewed rows from the separate "MNAB Import Inbox" spreadsheet into
 * this sheet's `transactions` tab.
 *
 * Why a separate inbox: tools that stage transactions (e.g. Claude reading
 * bank screenshots) only ever get access to the inbox file, never to this
 * spreadsheet or its history. A person reviews each staged row, ticks
 * Approve, and this menu item does the actual write into the ledger.
 *
 * Inbox layout (tab `inbox`, matched by header name, so column order doesn't
 * matter):
 *   Inbox ID          permanent unique ID per staged row, e.g. INB-20261029-01
 *   Approve           checkbox — only ticked rows are imported
 *   Status            "Staged" -> "Imported" (written by this script)
 *   Payee, Income/Expense, SOF, Date, Month, Cleared, Amount, Transfer, Notes
 *                     copied into the same-named transactions columns
 *   Expense, Income, Total
 *                     review-only formulas in the inbox; recomputed here
 *                     from Amount and Income/Expense, never copied
 *   Staged At         when the row was staged
 *   Imported At       written by this script
 *   Transactions Row  written by this script: the row it landed on in
 *                     `transactions` (the audit trail back into the ledger)
 *   Delete After Import
 *                     checkbox, default ticked. After each run, every ticked
 *                     row is deleted from the inbox, whether or not it was
 *                     imported (approved or not, skipped or not). Untick it
 *                     to keep a row. A blank cell counts as ticked. The
 *                     column is added (ticked for every existing row) on the
 *                     first run if it's missing.
 *
 * Safety rules:
 *   - Shows a confirmation with the row count and totals before writing.
 *   - SOF must exactly match an `Accounts` Name; anything that fails a check
 *     is skipped, listed in the summary, and left untouched in the inbox.
 *   - Each imported row's Inbox ID is stored in a self-provisioned
 *     `Inbox ID` column on `transactions`. A row whose ID is already there is
 *     never written twice — it's just marked Imported, pointing at the
 *     existing row. So re-running after a partial failure is safe.
 *   - Only appends to `transactions`; never edits or deletes existing rows.
 *   - Inbox rows are deleted only after the ledger write and only if the
 *     confirmation was accepted. One exception to the checkbox: a row whose
 *     Inbox ID is already used by a *different* transaction (different SOF,
 *     date or amount — e.g. an ID reused after the original row was deleted)
 *     is skipped and kept, so it can't vanish without reaching the ledger.
 *
 * Depends on headerIndexMap(), ensureColumn(), getAccountRows(),
 * payeeHeaderName() and billingMonthForDate() from Reconcile.gs
 * (apps-script/Reconciliations.gs), so it must live in the same Apps Script
 * project. Wired to the Finances menu in that file's onOpen().
 *
 * One-time setup: the account that runs this must be able to open the inbox
 * spreadsheet (it's shared with it as Editor). The first run asks for
 * permission to open other spreadsheets.
 */

const INBOX_CONFIG = {
  spreadsheetId: '14cB1nuTPlqHZwW1kn9OTPnTM0Y3iL9MsoBlwqiQrvFE',
  sheetName: 'inbox',
  idColumn: 'Inbox ID',
  stagedStatus: 'Staged',
  importedStatus: 'Imported',
  deleteColumn: 'Delete After Import',
};

/** Menu entry point. */
function importFromInbox() {
  const ui = SpreadsheetApp.getUi();
  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(30000)) {
    ui.alert('Another import or script is running. Try again in a moment.');
    return;
  }
  try {
    const result = inbox_import_(ui);
    if (result) ui.alert('Inbox import', result, ui.ButtonSet.OK);
  } catch (err) {
    ui.alert('Inbox import failed', String(err && err.message || err), ui.ButtonSet.OK);
  } finally {
    lock.releaseLock();
  }
}

/** Returns the summary text to show, or null if the user cancelled. */
function inbox_import_(ui) {
  const inboxSheet = SpreadsheetApp.openById(INBOX_CONFIG.spreadsheetId)
    .getSheetByName(INBOX_CONFIG.sheetName);
  if (!inboxSheet) throw new Error('Inbox tab "' + INBOX_CONFIG.sheetName + '" not found.');

  const ss = SpreadsheetApp.getActive();
  const txnSheet = ss.getSheetByName(RECONCILE_CONFIG.transactionsSheet);
  const accountsSheet = ss.getSheetByName(RECONCILE_CONFIG.accountsSheet);
  if (!txnSheet || !accountsSheet) throw new Error('transactions or Accounts tab not found.');

  const accounts = {};
  getAccountRows(accountsSheet).forEach(function (a) { accounts[a.name] = a; });

  // ---- read the inbox ----
  const inCol = headerIndexMap(inboxSheet);
  ['Inbox ID', 'Approve', 'Status', 'Payee', 'Income/Expense', 'SOF', 'Date', 'Amount',
   'Imported At', 'Transactions Row'].forEach(function (h) {
    if (!(h in inCol)) throw new Error('Inbox is missing the "' + h + '" column.');
  });
  const inLast = inboxSheet.getLastRow();
  if (inLast < 2) return 'The inbox is empty.';
  const delCol = inbox_ensureDeleteColumn_(inboxSheet, inLast);
  const inRows = inboxSheet.getRange(2, 1, inLast - 1, inboxSheet.getLastColumn()).getValues();

  // ---- existing Inbox IDs already in transactions ----
  const idCol = ensureColumn(txnSheet, INBOX_CONFIG.idColumn);
  const txCol = headerIndexMap(txnSheet);
  const txLast = txnSheet.getLastRow();
  const existing = {};  // Inbox ID -> { row, sof, date, amount }
  if (txLast >= 2) {
    txnSheet.getRange(2, 1, txLast - 1, txnSheet.getLastColumn()).getValues().forEach(function (r, i) {
      const id = String(r[idCol] || '').trim();
      if (!id) return;
      existing[id] = {
        row: i + 2,
        sof: 'SOF' in txCol ? String(r[txCol['SOF']]).trim() : '',
        date: 'Date' in txCol ? r[txCol['Date']] : '',
        amount: 'Amount' in txCol ? Number(r[txCol['Amount']]) : NaN,
      };
    });
  }

  // ---- pick and validate approved rows ----
  const toWrite = [];    // { inboxRow, id, txn }
  const alreadyIn = [];  // { inboxRow, id, txnRow }
  const skipped = [];    // "INB-… (reason)"
  const toDelete = {};   // inboxRow -> true
  const keep = {};       // inboxRow -> true: never deleted this run (ID collision)
  const seenIds = {};
  inRows.forEach(function (r, i) {
    const inboxRow = i + 2;
    if (inbox_isBlankRow_(r, inCol)) return;
    if (r[delCol] === true || r[delCol] === '') toDelete[inboxRow] = true;
    if (r[inCol['Approve']] !== true) return;
    if (String(r[inCol['Status']]).trim() !== INBOX_CONFIG.stagedStatus) return;

    const id = String(r[inCol['Inbox ID']] || '').trim();
    const reason = inbox_validate_(r, inCol, accounts, id, seenIds);
    if (reason) { skipped.push((id || 'row ' + inboxRow) + ' (' + reason + ')'); return; }
    seenIds[id] = true;

    if (existing[id]) {
      const ex = existing[id];
      if (!inbox_sameTxn_(ex, r, inCol)) {
        skipped.push(id + ' (Inbox ID already used by a different transaction, transactions row ' +
          ex.row + '; row kept in the inbox)');
        keep[inboxRow] = true;
        return;
      }
      alreadyIn.push({ inboxRow: inboxRow, id: id, txnRow: ex.row });
      return;
    }

    const type = String(r[inCol['Income/Expense']]).trim();
    const sof = String(r[inCol['SOF']]).trim();
    const date = r[inCol['Date']];
    const account = accounts[sof];
    const isCash = !String(account.type || '').toLowerCase().includes('credit');
    const monthRaw = 'Month' in inCol ? r[inCol['Month']] : '';
    toWrite.push({
      inboxRow: inboxRow,
      id: id,
      txn: {
        payee: String(r[inCol['Payee']]).trim(),
        type: type,
        sof: sof,
        date: date,
        month: monthRaw instanceof Date ? monthRaw : billingMonthForDate(date, isCash),
        cleared: 'Cleared' in inCol && String(r[inCol['Cleared']]).trim() === 'Uncleared' ? 'Uncleared' : 'Cleared',
        amount: Number(r[inCol['Amount']]),
        transfer: 'Transfer' in inCol && r[inCol['Transfer']] === true,
        notes: 'Notes' in inCol ? String(r[inCol['Notes']] || '') : '',
      },
    });
  });

  Object.keys(keep).forEach(function (k) { delete toDelete[k]; });
  const deleteRows = Object.keys(toDelete).map(Number).sort(function (a, b) { return a - b; });
  const importedRows = {};
  toWrite.forEach(function (w) { importedRows[w.inboxRow] = true; });
  alreadyIn.forEach(function (a) { importedRows[a.inboxRow] = true; });
  const deleteNotImported = deleteRows.filter(function (n) { return !importedRows[n]; }).length;

  if (!toWrite.length && !alreadyIn.length && !deleteRows.length) {
    return 'Nothing to import: no rows are ticked Approve with Status "Staged".' +
      (skipped.length ? '\n\nSkipped:\n' + skipped.join('\n') : '');
  }

  // ---- confirm (only when something will be added or deleted) ----
  if (toWrite.length || deleteRows.length) {
    const parts = [];
    if (toWrite.length) {
      let exp = 0, inc = 0;
      toWrite.forEach(function (w) { if (w.txn.type === 'Expense') exp += w.txn.amount; else inc += w.txn.amount; });
      parts.push('Add ' + toWrite.length + ' row(s) to transactions.\n' +
        'Expenses: Rp ' + exp.toLocaleString('id-ID') + '\n' +
        'Income: Rp ' + inc.toLocaleString('id-ID'));
    } else {
      parts.push('No new rows to add to transactions.');
    }
    if (alreadyIn.length) parts.push(alreadyIn.length + ' approved row(s) are already in transactions and will only be marked Imported.');
    if (skipped.length) parts.push(skipped.length + ' row(s) will be skipped:\n' + skipped.join('\n'));
    if (deleteRows.length) {
      parts.push('Then delete ' + deleteRows.length + ' row(s) ticked "' + INBOX_CONFIG.deleteColumn +
        '" from the inbox' + (deleteNotImported ? ', including ' + deleteNotImported + ' that were NOT imported' : '') + '.');
    }
    if (ui.alert('Import from inbox', parts.join('\n\n') + '\n\nContinue?', ui.ButtonSet.YES_NO) !== ui.Button.YES) return null;
  }

  // ---- append to transactions (one contiguous block) ----
  const width = txnSheet.getLastColumn();
  const startRow = txnSheet.getLastRow() + 1;
  const payeeHeader = payeeHeaderName(txCol);
  const block = toWrite.map(function (w) {
    const t = w.txn;
    const row = new Array(width).fill('');
    const set = function (h, v) { if (h in txCol) row[txCol[h]] = v; };
    if (payeeHeader) row[txCol[payeeHeader]] = t.payee;
    set('Income/Expense', t.type);
    set('SOF', t.sof);
    set('Date', t.date);
    set('Month', t.month);
    set('Cleared', t.cleared);
    set('Amount', t.amount);
    const expense = t.type === 'Expense' ? t.amount : 0;
    const income = t.type === 'Income' ? t.amount : 0;
    set('Expense', expense);
    set('Income', income);
    set('Total', expense - income);
    set('Notes', t.notes);
    if (t.transfer) set('Transfer', true);
    row[idCol] = w.id;
    return row;
  });
  if (block.length) txnSheet.getRange(startRow, 1, block.length, width).setValues(block);
  SpreadsheetApp.flush();

  // ---- write status back to the inbox ----
  const now = new Date();
  const statusCol = inCol['Status'] + 1;
  const atCol = inCol['Imported At'] + 1;
  const rowCol = inCol['Transactions Row'] + 1;
  const markImported = function (inboxRow, txnRow) {
    inboxSheet.getRange(inboxRow, statusCol).setValue(INBOX_CONFIG.importedStatus);
    inboxSheet.getRange(inboxRow, atCol).setValue(now);
    inboxSheet.getRange(inboxRow, rowCol).setValue(txnRow);
  };
  // Rows about to be deleted don't need their status written.
  toWrite.forEach(function (w, i) { if (!toDelete[w.inboxRow]) markImported(w.inboxRow, startRow + i); });
  alreadyIn.forEach(function (a) { if (!toDelete[a.inboxRow]) markImported(a.inboxRow, a.txnRow); });
  SpreadsheetApp.flush();

  // ---- delete ticked rows from the inbox ----
  if (deleteRows.length) inbox_deleteRows_(inboxSheet, deleteRows);

  const lines = [];
  if (toWrite.length) {
    lines.push('Added ' + toWrite.length + ' row(s) to transactions, rows ' +
      startRow + '–' + (startRow + toWrite.length - 1) + '.');
  }
  if (alreadyIn.length) lines.push(alreadyIn.length + ' row(s) were already in transactions; marked Imported.');
  if (skipped.length) lines.push('Skipped ' + skipped.length + ':\n' + skipped.join('\n'));
  if (deleteRows.length) {
    lines.push('Deleted ' + deleteRows.length + ' row(s) from the inbox' +
      (deleteNotImported ? ' (' + deleteNotImported + ' not imported)' : '') + '.');
  }
  return lines.join('\n\n');
}

/**
 * Makes sure the inbox has the "Delete After Import" checkbox column.
 * When it's first added, every existing data row is ticked (the default).
 * Returns its 0-based column index.
 */
function inbox_ensureDeleteColumn_(inboxSheet, inLast) {
  const before = headerIndexMap(inboxSheet);
  if (INBOX_CONFIG.deleteColumn in before) return before[INBOX_CONFIG.deleteColumn];
  const col = ensureColumn(inboxSheet, INBOX_CONFIG.deleteColumn);
  if (inLast >= 2) {
    const range = inboxSheet.getRange(2, col + 1, inLast - 1, 1);
    range.setDataValidation(SpreadsheetApp.newDataValidation().requireCheckbox().build());
    range.setValues(Array.from({ length: inLast - 1 }, function () { return [true]; }));
  }
  SpreadsheetApp.flush();
  return col;
}

/** A row with no Inbox ID, Payee or Amount is treated as empty and ignored. */
function inbox_isBlankRow_(r, inCol) {
  return ['Inbox ID', 'Payee', 'Amount'].every(function (h) {
    return String(r[inCol[h]] == null ? '' : r[inCol[h]]).trim() === '';
  });
}

/** Does an existing transactions row (by Inbox ID) look like this inbox row? */
function inbox_sameTxn_(ex, r, inCol) {
  const sof = String(r[inCol['SOF']]).trim();
  const date = r[inCol['Date']];
  const amount = Number(r[inCol['Amount']]);
  const sameDay = ex.date instanceof Date && date instanceof Date &&
    ex.date.getFullYear() === date.getFullYear() &&
    ex.date.getMonth() === date.getMonth() &&
    ex.date.getDate() === date.getDate();
  return ex.sof === sof && sameDay && ex.amount === amount;
}

/** Deletes the given 1-based rows, bottom-up, in contiguous blocks. */
function inbox_deleteRows_(sheet, rows) {
  // Sheets refuses to delete every non-frozen row, so keep one spare.
  const frozen = sheet.getFrozenRows();
  if (sheet.getMaxRows() - rows.length <= frozen) sheet.insertRowsAfter(sheet.getMaxRows(), 1);
  const desc = rows.slice().sort(function (a, b) { return b - a; });
  let i = 0;
  while (i < desc.length) {
    let start = desc[i];
    let count = 1;
    while (i + count < desc.length && desc[i + count] === start - 1) { start--; count++; }
    sheet.deleteRows(start, count);
    i += count;
  }
}

/** Returns a reason string if the inbox row can't be imported, else ''. */
function inbox_validate_(r, inCol, accounts, id, seenIds) {
  if (!id) return 'no Inbox ID';
  if (seenIds[id]) return 'duplicate Inbox ID in the inbox';
  if (!String(r[inCol['Payee']] || '').trim()) return 'no Payee';
  const type = String(r[inCol['Income/Expense']]).trim();
  if (type !== 'Expense' && type !== 'Income') return 'Income/Expense must be Expense or Income';
  const sof = String(r[inCol['SOF']]).trim();
  if (!accounts[sof]) return 'SOF "' + sof + '" is not an Accounts name';
  if (!(r[inCol['Date']] instanceof Date)) return 'Date is not a date';
  const amount = Number(r[inCol['Amount']]);
  if (!(amount > 0)) return 'Amount must be a positive number';
  return '';
}
