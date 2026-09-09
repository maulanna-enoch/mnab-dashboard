/**
 * Google Apps Script: Copy Installments & Bills to Transactions
 * ----------------------------------------------------------------
 * Two ways to run this:
 *   - Manually: Finances > Copy Installments & Bills to Transactions…
 *   - Automatically: Finances > Set Up Daily Auto-Copy… (one-time setup) --
 *     installs a daily ~6am trigger so you never have to remember to run
 *     it. Safe to run daily because of the duplicate protection below:
 *     each day it just checks whether the next-due row already exists and
 *     is a no-op if so. Finances > Remove Daily Auto-Copy… undoes it.
 * (onOpen() lives in Reconcile.gs -- Apps Script only allows one onOpen()
 * per project, so the menu wiring for all of the above is there, not here.)
 *
 * DEPENDS ON helpers already defined in Reconcile.gs -- every .gs file in
 * an Apps Script project shares one global namespace, so this reuses
 * headerIndexMap(), ensureColumn(), payeeHeaderName(), billingMonthForDate(),
 * and formatDate() rather than redefining them. Keep this file in the same
 * project as Reconcile.gs.
 *
 * installmentsbills columns: A Name | B SOF | C Amount | D is_active |
 *   E Ends | F Starts | G Months | H Remarks | I Day of Month
 * (matches the real sheet -- see mnab-dashboard/api/_lib/sheets.js's
 * fetchInstallmentRows for the read-side of this same tab). A new "ID"
 * column is self-provisioned by this script (appended after whatever's
 * already there) and auto-filled with a permanent IB-1, IB-2, ... code for
 * any row that doesn't have one yet -- once assigned, an ID never changes,
 * even if you reorder or edit other columns on that row. Don't hand-edit
 * these.
 *
 * For every row where is_active is TRUE, appends one row to `transactions`
 * (unless duplicate protection skips it -- see below):
 *   Payee          <- installmentsbills Name
 *   Income/Expense <- "Expense" (always)
 *   SOF            <- installmentsbills SOF
 *   Date           <- Day = installmentsbills "Day of Month" (clamped to
 *                     the target month's last valid day). Month/Year = the
 *                     first occurrence of that day on or after today --
 *                     e.g. run on Aug 19, Day of Month 15 -> Sep 15 (the
 *                     15th already passed this month); Day of Month 25 ->
 *                     Aug 25 (hasn't happened yet this month); Day of
 *                     Month 19 -> Aug 19 (today itself).
 *   Month          <- the same "day 1-12 -> this calendar month, day 13+
 *                     -> next month" billing-month guess used everywhere
 *                     else in this sheet (billingMonthForDate in
 *                     Reconcile.gs), applied to the Date computed above.
 *   Cleared        <- "Uncleared"
 *   Pending        <- TRUE -- same self-provisioned boolean column
 *                     EmailImport.gs uses (see issue #38); an auto-inserted
 *                     row hasn't been reviewed by you yet, so it's marked
 *                     pending the same way an auto-imported bank email is,
 *                     until you confirm/save it (which clears Pending, see
 *                     api/transactions-update.js).
 *   Amount/Expense/Income/Total <- installmentsbills Amount, taken as-is
 *                     (Expense = Amount, Income = 0, Total = Amount, since
 *                     every row here is an Expense)
 *   Notes          <- "Auto-insert NN/MM" for installments -- NN = which
 *                     installment this occurrence is, MM = the total
 *                     count, both INFERRED from Starts/Ends (not read from
 *                     the sheet's "Months" column) by counting calendar
 *                     months from Starts through the computed Date and
 *                     through Ends respectively. Just "Auto-insert" (no
 *                     number) for evergreen bills (Ends >= year 2099, the
 *                     same convention BILL_YEAR_THRESHOLD uses elsewhere
 *                     in this sheet) -- they don't have an installment
 *                     count to show.
 *   Source ID      <- the installmentsbills row's ID (e.g. "IB-3"). This
 *                     column is self-provisioned on `transactions` too,
 *                     appended at the end so it doesn't disturb existing
 *                     columns. Only auto-inserted rows get one -- it's
 *                     blank on anything you enter by hand.
 *
 * DUPLICATE PROTECTION: keyed on (Source ID, cycle window) -- not the exact
 * Date, on purpose. Each row's "cycle window" is (previous month's
 * occurrence of this same due day, this occurrence] -- e.g. due day 14:
 * the window for the Oct 14 occurrence is everything after Sep 14 up to
 * and including Oct 14. A transaction dated anywhere in that window --
 * paid right on the computed due date, or a few days/weeks early -- is
 * recognized as "this cycle's occurrence" and blocks a second insert.
 * (Before this, an early manual payment landed on a different exact Date
 * than the computed due date, matched nothing, and got a duplicate
 * auto-inserted on top of it -- see the "early payment" fix below. A plain
 * calendar-month or billingMonthForDate() bucket doesn't work for this: a
 * late-month due date like the 14th falls in a different
 * billingMonthForDate() "billing month" than an early payment made earlier
 * in that same actual month, e.g. the 7th -- back to the same bug, just
 * shifted. The cycle window is anchored to each row's own due day instead,
 * so it doesn't depend on that statement-cycle heuristic.) NOT keyed on
 * Payee, SOF, or Amount, on purpose, since those are exactly the fields
 * you edit for readability after the fact (renaming payees, re-tagging
 * SOF, etc.). Source ID is stable and never displayed as something you'd
 * casually touch, so editing the transaction's other fields can never
 * cause a re-insert.
 *
 * ADOPT-INSTEAD-OF-DUPLICATE: covers two cases with one mechanism --
 * historical rows this script inserted before Source ID existed, AND (as
 * of the early-payment fix) any transaction you enter by hand yourself for
 * a bill/installment before this script gets to it, e.g. paying a card
 * statement a few days before its due date. Before creating anything, each
 * active installmentsbills row is checked against untagged transactions
 * matching on Payee + SOF (case-insensitive) with a Date inside that row's
 * cycle window (see above) -- a match found this way is ADOPTED: its
 * Source ID is backfilled in place rather than inserting a duplicate. Only
 * the Source ID cell is touched -- whatever Date, Amount, Cleared, etc.
 * you actually entered is left exactly as you entered it. This only works
 * for rows whose Payee and SOF match the installmentsbills row
 * (case-insensitive) and whose Date falls inside the cycle window -- if
 * you paid through a different SOF than configured, the payee text
 * doesn't match, or you paid more than about a month ahead of the due
 * date, it won't be found this way; you can always paste the Source ID
 * (e.g. "IB-3") into that transaction's Source ID column yourself as a
 * guaranteed alternative. Adoptions are reported in the run summary/log
 * distinctly from ordinary copies and skips.
 *
 * A row is SKIPPED (logged, nothing written for it) if:
 *   - a transaction with this Source ID already exists in this cycle
 *     window (ordinary duplicate protection, see above), or
 *   - it's an installment (not a bill) and Starts or Ends is missing/not a
 *     real date, so the installment number can't be computed, or
 *   - it's an installment and the computed Date's month falls outside
 *     [Starts, Ends] -- the installment hasn't started yet or has already
 *     finished, so writing a numbered installment transaction for it
 *     would be wrong.
 * Bills never hit the last two since they don't have a real end date.
 *
 * LOGGING: every run (manual or automatic, clean or not) appends one row
 * to an auto-created "Auto-Copy Log" tab: timestamp, how it was triggered,
 * how many copied, how many adopted (migration backfills), how many
 * skipped, and why. Manual runs also get a dialog; automatic runs never
 * call SpreadsheetApp.getUi() at all, since that throws when there's no
 * one there to show it to (this is the bug that would otherwise silently
 * kill the daily trigger).
 *
 * SETUP:
 * 1. Extensions > Apps Script > add a new file (the + next to Files) named
 *    "InstallmentsBills", paste this in.
 * 2. Add to Reconcile.gs's onOpen():
 *      .addItem('Copy Installments & Bills to Transactions…', 'copyInstallmentsBillsToTransactions')
 *      .addItem('Set Up Daily Auto-Copy…', 'setupDailyTrigger')
 *      .addItem('Remove Daily Auto-Copy…', 'removeDailyTrigger')
 * 3. Adjust INSTALLMENTS_CONFIG below if your column layout differs.
 * 4. Save, reload the sheet.
 * 5. Finances > Set Up Daily Auto-Copy… (one-time -- you'll get an
 *    authorization prompt the first time since creating triggers needs
 *    extra permission). From then on it just runs itself.
 */

const INSTALLMENTS_CONFIG = {
  SOURCE_SHEET_NAME: 'installmentsbills',
  TRANSACTIONS_SHEET_NAME: 'transactions',
  LOG_SHEET_NAME: 'Auto-Copy Log',
  BILL_YEAR_THRESHOLD: 2099, // same convention as api/_lib/sheets.js
  DAILY_TRIGGER_HANDLER: 'automaticDailyCopy',
  DAILY_TRIGGER_HOUR: 6, // ~6am; Apps Script gives an hour-wide window, not the exact minute

  ID_COLUMN_NAME: 'ID',           // self-provisioned on installmentsbills
  ID_PREFIX: 'IB-',
  SOURCE_ID_COLUMN_NAME: 'Source ID', // self-provisioned on transactions
  PENDING_COLUMN_NAME: 'Pending', // self-provisioned on transactions -- same column EmailImport.gs uses

  // installmentsbills column positions (1-indexed) -- unrelated to ID,
  // which is looked up by header name since it's appended dynamically.
  COL_NAME: 1,
  COL_SOF: 2,
  COL_AMOUNT: 3,
  COL_ACTIVE: 4,
  COL_ENDS: 5,
  COL_STARTS: 6,
  COL_MONTHS: 7,   // not used for the installment counter -- see file header
  COL_REMARKS: 8,  // not used
  COL_DAY_OF_MONTH: 9,
};

/** Menu entry point -- interactive, shows a dialog with the result. */
function copyInstallmentsBillsToTransactions() {
  const result = runInstallmentsBillsCopy_('Manual');
  if (result.error) {
    SpreadsheetApp.getUi().alert(result.error);
    return;
  }
  let msg = 'Copied ' + result.copiedCount + ' row(s) to ' + INSTALLMENTS_CONFIG.TRANSACTIONS_SHEET_NAME + '.';
  if (result.adopted.length) msg += '\n\nAdopted ' + result.adopted.length + ' existing row(s) onto their new Source ID:\n' + result.adopted.join('\n');
  if (result.skipped.length) msg += '\n\nSkipped ' + result.skipped.length + ':\n' + result.skipped.join('\n');
  SpreadsheetApp.getUi().alert(msg);
}

/**
 * Trigger entry point -- bound to the daily time-driven trigger by
 * setupDailyTrigger(). Deliberately never touches SpreadsheetApp.getUi():
 * calling it from an automatic trigger throws and would silently kill
 * every future scheduled run. All feedback goes to the Auto-Copy Log tab.
 */
function automaticDailyCopy() {
  runInstallmentsBillsCopy_('Automatic');
}

/**
 * Shared logic. Always writes one row to the Auto-Copy Log tab. Returns
 * { copiedCount, adopted, skipped, error } -- callers decide how to
 * surface it.
 */
function runInstallmentsBillsCopy_(triggerType) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sourceSheet = ss.getSheetByName(INSTALLMENTS_CONFIG.SOURCE_SHEET_NAME);
  const txnSheet = ss.getSheetByName(INSTALLMENTS_CONFIG.TRANSACTIONS_SHEET_NAME);

  if (!sourceSheet || !txnSheet) {
    const error =
      `Check INSTALLMENTS_CONFIG: "${INSTALLMENTS_CONFIG.SOURCE_SHEET_NAME}" or ` +
      `"${INSTALLMENTS_CONFIG.TRANSACTIONS_SHEET_NAME}" sheet not found.`;
    logAutoCopyRun_(ss, triggerType, 0, 0, [error]);
    return { copiedCount: 0, adopted: [], skipped: [], error };
  }

  const lastRow = sourceSheet.getLastRow();
  if (lastRow < 2) {
    logAutoCopyRun_(ss, triggerType, 0, 0, []);
    return { copiedCount: 0, adopted: [], skipped: [] };
  }

  // ---- installmentsbills: ensure every row has a permanent ID ----
  const idCol = ensureColumn(sourceSheet, INSTALLMENTS_CONFIG.ID_COLUMN_NAME); // 0-based, from Reconcile.gs
  backfillSourceIds_(sourceSheet, idCol, lastRow);
  const idValues = sourceSheet.getRange(2, idCol + 1, lastRow - 1, 1).getValues().map((r) => r[0]);

  // ---- transactions: ensure the Source ID and Pending columns exist ----
  ensureColumn(txnSheet, INSTALLMENTS_CONFIG.SOURCE_ID_COLUMN_NAME); // from Reconcile.gs
  ensureColumn(txnSheet, INSTALLMENTS_CONFIG.PENDING_COLUMN_NAME); // from Reconcile.gs -- same self-provisioned column EmailImport.gs uses
  const colIndex = headerIndexMap(txnSheet); // from Reconcile.gs, re-read after ensureColumn calls above
  ['SOF', 'Date', 'Cleared'].forEach((h) => {
    if (!(h in colIndex)) throw new Error(`transactions tab is missing a "${h}" column.`);
  });
  const payeeHeader = payeeHeaderName(colIndex); // from Reconcile.gs

  const { bySourceId, legacyByPayeeSof } = indexExistingTransactions_(txnSheet, colIndex, payeeHeader);

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const values = sourceSheet
    .getRange(2, 1, lastRow - 1, INSTALLMENTS_CONFIG.COL_DAY_OF_MONTH)
    .getValues();

  const newRows = [];
  const adopted = [];
  const skipped = [];

  values.forEach((row, i) => {
    const name = row[INSTALLMENTS_CONFIG.COL_NAME - 1];
    if (!name) return; // blank row

    const isActive = row[INSTALLMENTS_CONFIG.COL_ACTIVE - 1] === true;
    if (!isActive) return;

    const sourceId = idValues[i];
    const sof = row[INSTALLMENTS_CONFIG.COL_SOF - 1] || '';
    const amount = Number(row[INSTALLMENTS_CONFIG.COL_AMOUNT - 1]) || 0;
    const endsRaw = row[INSTALLMENTS_CONFIG.COL_ENDS - 1];
    const startsRaw = row[INSTALLMENTS_CONFIG.COL_STARTS - 1];
    const dayOfMonth = row[INSTALLMENTS_CONFIG.COL_DAY_OF_MONTH - 1];

    const endDate = endsRaw instanceof Date ? endsRaw : null;
    const startDate = startsRaw instanceof Date ? startsRaw : null;
    const isBill = !!endDate && endDate.getFullYear() >= INSTALLMENTS_CONFIG.BILL_YEAR_THRESHOLD;

    // ---- Date: day-of-month, first occurrence on or after today ----
    const day = Math.max(1, Math.min(Number(dayOfMonth) || 1, 31));
    let targetMonth = today.getMonth();
    let date = clampedDate(today.getFullYear(), targetMonth, day);
    if (date < today) {
      date = clampedDate(today.getFullYear(), targetMonth + 1, day);
    }

    // This cycle's window: anything dated after the *previous* month's
    // occurrence of this same due day, up to and including this occurrence,
    // counts as the same cycle -- so a manual payment entered a few days
    // (or weeks) before the computed due date is still recognized as
    // covering it, not just an exact date match. Anchored to this row's own
    // due day rather than the shared billingMonthForDate() statement-cycle
    // heuristic on purpose: that heuristic's day-12/13 split can land a
    // late-month due date (e.g. the 14th) in a different "billing month"
    // than an early payment made earlier in that same actual month -- see
    // file header.
    const cycleStart = clampedDate(date.getFullYear(), date.getMonth() - 1, day);
    const inThisCycle = (d) => d > cycleStart && d <= date;

    // ---- duplicate protection: has this cycle already been copied? ----
    const existingDates = bySourceId.get(sourceId) || [];
    if (existingDates.some(inThisCycle)) {
      skipped.push(name + ' -- already exists for this cycle (due ' + formatDate(date) + ', Source ID ' + sourceId + '), skipped (duplicate protection).');
      return;
    }

    // ---- adopt an existing untagged transaction from this cycle (historical pre-Source-ID row, or a manual early payment) instead of inserting a duplicate ----
    const legacyKey = String(name).trim().toLowerCase() + '|' + String(sof).trim().toLowerCase();
    const legacyCandidates = legacyByPayeeSof.get(legacyKey) || [];
    const legacyMatch = legacyCandidates.find((c) => inThisCycle(c.date));
    if (legacyMatch) {
      txnSheet.getRange(legacyMatch.rowNumber, colIndex[INSTALLMENTS_CONFIG.SOURCE_ID_COLUMN_NAME] + 1).setValue(sourceId);
      existingDates.push(legacyMatch.date); // now covered, don't adopt or insert again this run
      bySourceId.set(sourceId, existingDates);
      adopted.push(name + ' -- tagged existing ' + formatDate(legacyMatch.date) + ' row with Source ID ' + sourceId + ' (due ' + formatDate(date) + ').');
      return;
    }

    // ---- installment numbering (skip for bills -- they're evergreen) ----
    let notes = 'Auto-insert';
    if (!isBill) {
      if (!startDate || !endDate) {
        skipped.push(name + ' -- missing Starts/Ends, can\'t compute installment number.');
        return;
      }
      if (date < startOfMonth(startDate) || date > endOfMonth(endDate)) {
        skipped.push(
          name + ' -- ' + formatDate(date) + ' falls outside its Starts/Ends range (' +
          formatDate(startDate) + ' to ' + formatDate(endDate) + ').'
        );
        return;
      }
      const total = monthDiff(startDate, endDate) + 1;
      const current = monthDiff(startDate, date) + 1;
      notes = 'Auto-insert ' + pad2(current) + '/' + pad2(total);
    }

    const month = billingMonthForDate(date); // from Reconcile.gs -- Month column only, unrelated to the cycle-window dedup above

    const txnRow = new Array(txnSheet.getLastColumn()).fill('');
    if (payeeHeader) txnRow[colIndex[payeeHeader]] = name;
    if ('Income/Expense' in colIndex) txnRow[colIndex['Income/Expense']] = 'Expense';
    txnRow[colIndex['SOF']] = sof;
    txnRow[colIndex['Date']] = date;
    if ('Month' in colIndex) txnRow[colIndex['Month']] = month;
    txnRow[colIndex['Cleared']] = 'Uncleared';
    txnRow[colIndex[INSTALLMENTS_CONFIG.PENDING_COLUMN_NAME]] = true;
    if ('Amount' in colIndex) txnRow[colIndex['Amount']] = amount;
    if ('Expense' in colIndex) txnRow[colIndex['Expense']] = amount;
    if ('Income' in colIndex) txnRow[colIndex['Income']] = 0;
    if ('Total' in colIndex) txnRow[colIndex['Total']] = amount;
    if ('Notes' in colIndex) txnRow[colIndex['Notes']] = notes;
    txnRow[colIndex[INSTALLMENTS_CONFIG.SOURCE_ID_COLUMN_NAME]] = sourceId;

    newRows.push(txnRow);
    // guard against duplicate active rows within the same run
    existingDates.push(date);
    bySourceId.set(sourceId, existingDates);
  });

  if (newRows.length) {
    const startRow = txnSheet.getLastRow() + 1;
    txnSheet.getRange(startRow, 1, newRows.length, txnSheet.getLastColumn()).setValues(newRows);
  }

  logAutoCopyRun_(ss, triggerType, newRows.length, adopted.length, skipped);
  return { copiedCount: newRows.length, adopted, skipped };
}

/**
 * Assigns a permanent IB-N id to any installmentsbills row that doesn't
 * have one yet, continuing from the highest N already in use. Existing
 * IDs are never touched or reassigned.
 */
function backfillSourceIds_(sheet, idCol, lastRow) {
  if (lastRow < 2) return;
  const range = sheet.getRange(2, idCol + 1, lastRow - 1, 1);
  const values = range.getValues();

  let maxN = 0;
  const pattern = new RegExp('^' + INSTALLMENTS_CONFIG.ID_PREFIX + '(\\d+)$');
  values.forEach((r) => {
    const m = pattern.exec(String(r[0] || '').trim());
    if (m) maxN = Math.max(maxN, Number(m[1]));
  });

  let changed = false;
  const updated = values.map((r) => {
    const v = String(r[0] || '').trim();
    if (v) return [v];
    changed = true;
    maxN += 1;
    return [INSTALLMENTS_CONFIG.ID_PREFIX + maxN];
  });
  if (changed) range.setValues(updated);
}

/**
 * One pass over `transactions`, building:
 *   bySourceId     -- Map of sourceId (trimmed string) -> array of Date,
 *                      for rows that already carry a Source ID (the
 *                      current, stable scheme). One sourceId can map to
 *                      several dates (one per past cycle).
 *   legacyByPayeeSof -- Map of "payee|sof" (lowercased) -> array of
 *                      { rowNumber, date }, but ONLY for rows with a BLANK
 *                      Source ID -- these are candidates for adoption
 *                      (historical pre-Source-ID rows, or a manual early
 *                      payment entered before this script got to it).
 *
 * Callers match against these by testing each candidate Date against a
 * per-row cycle window (see runInstallmentsBillsCopy_'s `inThisCycle`),
 * not an exact date or a shared billing-month bucket -- see the file
 * header's DUPLICATE PROTECTION / ADOPT-INSTEAD-OF-DUPLICATE notes for why.
 */
function indexExistingTransactions_(txnSheet, colIndex, payeeHeader) {
  const bySourceId = new Map();
  const legacyByPayeeSof = new Map();
  const lastRow = txnSheet.getLastRow();
  if (lastRow < 2) return { bySourceId, legacyByPayeeSof };

  const values = txnSheet.getRange(2, 1, lastRow - 1, txnSheet.getLastColumn()).getValues();
  values.forEach((row, i) => {
    const date = row[colIndex['Date']];
    if (!(date instanceof Date)) return;

    const sourceId = row[colIndex[INSTALLMENTS_CONFIG.SOURCE_ID_COLUMN_NAME]];
    if (sourceId) {
      const key = String(sourceId).trim();
      if (!bySourceId.has(key)) bySourceId.set(key, []);
      bySourceId.get(key).push(date);
      return;
    }

    if (!payeeHeader) return;
    const payee = row[colIndex[payeeHeader]];
    const sof = row[colIndex['SOF']];
    if (!payee || !sof) return;
    const key = String(payee).trim().toLowerCase() + '|' + String(sof).trim().toLowerCase();
    if (!legacyByPayeeSof.has(key)) legacyByPayeeSof.set(key, []);
    legacyByPayeeSof.get(key).push({ rowNumber: i + 2, date });
  });

  return { bySourceId, legacyByPayeeSof };
}

function logAutoCopyRun_(ss, triggerType, copiedCount, adoptedCount, skipped) {
  let logSheet = ss.getSheetByName(INSTALLMENTS_CONFIG.LOG_SHEET_NAME);
  if (!logSheet) {
    logSheet = ss.insertSheet(INSTALLMENTS_CONFIG.LOG_SHEET_NAME);
    logSheet.getRange(1, 1, 1, 6).setValues([['Timestamp', 'Trigger', 'Copied', 'Adopted', 'Skipped Count', 'Skipped Details']]);
  }
  logSheet.appendRow([new Date(), triggerType, copiedCount, adoptedCount, skipped.length, skipped.join(' | ')]);
}

/** Menu entry point: one-time setup of the daily automatic run. */
function setupDailyTrigger() {
  const ui = SpreadsheetApp.getUi();
  const already = ScriptApp.getProjectTriggers().some(
    (t) => t.getHandlerFunction() === INSTALLMENTS_CONFIG.DAILY_TRIGGER_HANDLER
  );
  if (already) {
    ui.alert('Daily Auto-Copy is already set up (runs ~' + INSTALLMENTS_CONFIG.DAILY_TRIGGER_HOUR + ':00 daily). Nothing changed.');
    return;
  }
  ScriptApp.newTrigger(INSTALLMENTS_CONFIG.DAILY_TRIGGER_HANDLER)
    .timeBased()
    .everyDays(1)
    .atHour(INSTALLMENTS_CONFIG.DAILY_TRIGGER_HOUR)
    .create();
  ui.alert(
    'Daily Auto-Copy is set up -- it\'ll run automatically around ' +
    INSTALLMENTS_CONFIG.DAILY_TRIGGER_HOUR + ':00 every day from now on. ' +
    'Check the "' + INSTALLMENTS_CONFIG.LOG_SHEET_NAME + '" tab for a record of every run.'
  );
}

/** Menu entry point: undo setupDailyTrigger(). */
function removeDailyTrigger() {
  const ui = SpreadsheetApp.getUi();
  const triggers = ScriptApp.getProjectTriggers().filter(
    (t) => t.getHandlerFunction() === INSTALLMENTS_CONFIG.DAILY_TRIGGER_HANDLER
  );
  if (!triggers.length) {
    ui.alert('No Daily Auto-Copy trigger is currently set up.');
    return;
  }
  triggers.forEach((t) => ScriptApp.deleteTrigger(t));
  ui.alert('Daily Auto-Copy trigger removed. Copying installments & bills to transactions is back to manual (Finances menu) only.');
}

function clampedDate(year, month, day) {
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  return new Date(year, month, Math.min(day, daysInMonth));
}

function startOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
function endOfMonth(d) { return new Date(d.getFullYear(), d.getMonth() + 1, 0); }

function monthDiff(a, b) {
  return (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
}

function pad2(n) { return String(n).padStart(2, '0'); }
