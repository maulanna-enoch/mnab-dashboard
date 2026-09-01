// Reconciliation backend logic -- a faithful Node/Sheets-API port of the
// Apps Script macro `Reconcile.gs`. Every function here mirrors a
// same-named (or clearly-corresponding) function there; see that file's
// comments for the "why" behind each rule. Kept in its own module rather
// than folded into sheets.js since it's a distinct, self-contained slice of
// logic (reconciliation only) that reads/writes three tabs by *header name*
// (not fixed A:K letters like the rest of this app) -- this tab already has
// extra columns (Reconciled, Reconciled Date, Last Reconciled Through/
// Statement) that the macro self-provisioned, in whatever order they ended
// up in, so column-letter assumptions would be fragile here specifically.

const { getSheetsClient, getWriteSheetsClient, getSheetGridId, serialToDate, dateToSerial, monthKey } = require('./sheets');

const RECONCILE_SHEETS = {
  transactions: 'transactions',
  accounts: 'Accounts',
  log: 'Reconciliations',
};

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

function round2(n) {
  return Math.round(n * 100) / 100;
}

function columnLetter(index0) {
  let n = index0 + 1;
  let letter = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    letter = String.fromCharCode(65 + rem) + letter;
    n = Math.floor((n - 1) / 26);
  }
  return letter;
}

// asOfDate / plain "YYYY-MM-DD" strings are parsed as UTC midnight, matching
// how the rest of this app already parses dates (see transactions-add.js) --
// consistent with serialToDate's UTC-epoch math.
function parseISODate(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(text || '').trim());
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatISODate(date) {
  return date.toISOString().slice(0, 10);
}

// "Today" in the user's timezone (WIB / Asia/Jakarta, UTC+7, no DST) as a
// UTC-midnight Date -- directly comparable with the UTC-midnight Date
// objects this module already uses for transaction dates (see
// parseISODate/serialToDate above). Vercel's serverless functions run in
// UTC, so naively reading `new Date()`'s own getUTCFullYear/etc. would read
// the wrong calendar day for the ~7 hours of every WIB day between 00:00 and
// 06:59 WIB (still "yesterday" in UTC) -- the same toISOString/timezone
// footgun called out elsewhere in this app (see transaction-form.js's
// todayISO), just server-side instead of client-side.
const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;
function todayWIBDate() {
  const wibNow = new Date(Date.now() + WIB_OFFSET_MS);
  return new Date(Date.UTC(wibNow.getUTCFullYear(), wibNow.getUTCMonth(), wibNow.getUTCDate()));
}

// Rough default for which billing month a transaction belongs to: dates
// early in the month (day <= 12) stay in that calendar month; later dates
// roll into the next one. Fixed version of the bug that also existed here
// and in public/shared/transaction-form.js: snap to day 1 *before*
// incrementing the month, otherwise a date like Aug 31 overflows into
// October (September only has 30 days) instead of landing on September.
function billingMonthForDate(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  if (d.getUTCDate() > 12) {
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + 1);
  } else {
    d.setUTCDate(1);
  }
  return d;
}

function parseISOMonth(text) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(text || '').trim());
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1));
  return Number.isNaN(d.getTime()) ? null : d;
}

async function getHeaderMap(sheets, spreadsheetId, sheetName) {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetName}!1:1`,
    valueRenderOption: 'UNFORMATTED_VALUE',
  });
  const headers = (response.data.values && response.data.values[0]) || [];
  const map = {};
  headers.forEach((h, i) => {
    if (h !== undefined && h !== null && h !== '') map[String(h).trim()] = i;
  });
  return map;
}

function requireColumns(map, sheetLabel, headers) {
  headers.forEach((h) => {
    if (!(h in map)) throw new Error(`${sheetLabel} tab is missing a "${h}" column.`);
  });
}

async function fetchAccountsForReconcile(sheets) {
  const spreadsheetId = process.env.SHEET_ID;
  const map = await getHeaderMap(sheets, spreadsheetId, RECONCILE_SHEETS.accounts);
  requireColumns(map, 'Accounts', ['Name']);

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${RECONCILE_SHEETS.accounts}!A2:Z`,
    valueRenderOption: 'UNFORMATTED_VALUE',
  });
  const rows = response.data.values || [];

  const accounts = rows
    .map((row, i) => {
      const name = row[map['Name']];
      if (!name) return null;
      const lastThroughSerial = map['Last Reconciled Through'] !== undefined ? row[map['Last Reconciled Through']] : undefined;
      const lastStmt = map['Last Reconciled Statement'] !== undefined ? row[map['Last Reconciled Statement']] : undefined;
      return {
        name: String(name).trim(),
        type: map['Type'] !== undefined ? (row[map['Type']] || '') : '',
        lastReconciledThrough: typeof lastThroughSerial === 'number' ? serialToDate(lastThroughSerial) : null,
        lastReconciledStatement: typeof lastStmt === 'number' ? lastStmt : null,
        rowNumber: i + 2,
      };
    })
    .filter(Boolean);

  return { map, accounts };
}

function findAccount(accounts, name) {
  return accounts.find((a) => a.name.toLowerCase() === String(name || '').toLowerCase());
}

async function fetchTransactionsForReconcile(sheets) {
  const spreadsheetId = process.env.SHEET_ID;
  const map = await getHeaderMap(sheets, spreadsheetId, RECONCILE_SHEETS.transactions);
  requireColumns(map, 'transactions', ['SOF', 'Date', 'Cleared', 'Reconciled', 'Reconciled Date']);
  const amountHeader = 'Total' in map ? 'Total' : 'Amount';
  if (!(amountHeader in map)) throw new Error('transactions tab needs a "Total" or "Amount" column.');
  const payeeHeader = 'Payee' in map ? 'Payee' : ('Name' in map ? 'Name' : null);

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${RECONCILE_SHEETS.transactions}!A2:Z`,
    valueRenderOption: 'UNFORMATTED_VALUE',
  });
  const values = response.data.values || [];

  const rows = values.map((row, i) => {
    const sofRaw = row[map['SOF']];
    const dateSerial = row[map['Date']];
    const monthSerial = map['Month'] !== undefined ? row[map['Month']] : undefined;
    const clearedRaw = String(row[map['Cleared']] || '').trim();
    const reconciledRaw = row[map['Reconciled']];
    const reconciledDateSerial = row[map['Reconciled Date']];
    const type = 'Income/Expense' in map && row[map['Income/Expense']] === 'Income' ? 'Income' : 'Expense';
    // amount = Total (signed: Income negative) when a Total column exists --
    // required for the reconciliation sum math (sumClearedTransactions etc)
    // to match Reconcile.gs exactly. displayAmount is always the positive,
    // human-facing figure (falls back to abs(Total) if there's no separate
    // Amount column) for rendering individual transaction rows.
    const displayAmount = 'Amount' in map ? Number(row[map['Amount']]) || 0 : Math.abs(Number(row[map[amountHeader]]) || 0);
    // Transfer / Payment ID: self-provisioned columns (see
    // getOrCreateTransactionsColumn below), same pattern as Reconciled /
    // Reconciled Date -- may not exist yet on a sheet that's never had a
    // mobile-logged card payment, so both reads are defensive (map[...] is
    // undefined -> row[undefined] is undefined -> falls through cleanly).
    const transferRaw = map['Transfer'] !== undefined ? row[map['Transfer']] : undefined;
    const paymentIdRaw = map['Payment ID'] !== undefined ? row[map['Payment ID']] : undefined;
    return {
      rowNumber: i + 2,
      sof: sofRaw ? String(sofRaw).trim() : '',
      date: typeof dateSerial === 'number' ? serialToDate(dateSerial) : null,
      month: typeof monthSerial === 'number' ? monthKey(serialToDate(monthSerial)) : null,
      cleared: clearedRaw,
      isCleared: clearedRaw.toLowerCase() === 'cleared',
      type,
      amount: Number(row[map[amountHeader]]) || 0,
      displayAmount,
      isReconciled: reconciledRaw === true,
      reconciledDate: typeof reconciledDateSerial === 'number' ? serialToDate(reconciledDateSerial) : null,
      payee: payeeHeader ? row[map[payeeHeader]] : '',
      notes: map['Notes'] !== undefined ? (row[map['Notes']] || '') : '',
      isTransfer: transferRaw === true || transferRaw === 'TRUE' || transferRaw === 'true',
      paymentId: paymentIdRaw ? String(paymentIdRaw).trim() : null,
    };
  });

  return { map, amountHeader, payeeHeader, rows };
}

// Incremental sum: Cleared, not-yet-reconciled transactions on this account
// since it was last reconciled -- the set that actually gets marked
// Reconciled=true on confirm.
function sumClearedTransactions(txnRows, accountName, sinceDate, asOfDate) {
  let sum = 0;
  const matchedRows = [];
  txnRows.forEach((r) => {
    if (!r.sof || r.sof.toLowerCase() !== accountName.toLowerCase()) return;
    if (!r.isCleared) return;
    if (r.isReconciled) return;
    if (!r.date) return;
    if (r.date <= sinceDate) return;
    if (r.date > asOfDate) return;
    sum += r.amount;
    matchedRows.push(r.rowNumber);
  });
  return { matchedRows, sum: round2(sum) };
}

// "Book balance": every Cleared transaction through asOfDate, reconciled or
// not -- the primary figure compared against the real statement.
function sumCumulativeClearedTransactions(txnRows, accountName, asOfDate) {
  let sum = 0;
  let count = 0;
  txnRows.forEach((r) => {
    if (!r.sof || r.sof.toLowerCase() !== accountName.toLowerCase()) return;
    if (!r.isCleared) return;
    if (!r.date) return;
    if (r.date > asOfDate) return;
    sum += r.amount;
    count++;
  });
  return { sum: round2(sum), count };
}

async function markRowsReconciled(sheets, map, rowNumbers, asOfDate) {
  if (!rowNumbers.length) return;
  const reconciledCol = columnLetter(map['Reconciled']);
  const reconciledDateCol = columnLetter(map['Reconciled Date']);
  const asOfSerial = dateToSerial(asOfDate);
  const data = [];
  rowNumbers.forEach((r) => {
    data.push({ range: `${RECONCILE_SHEETS.transactions}!${reconciledCol}${r}`, values: [[true]] });
    data.push({ range: `${RECONCILE_SHEETS.transactions}!${reconciledDateCol}${r}`, values: [[asOfSerial]] });
  });
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: process.env.SHEET_ID,
    requestBody: { valueInputOption: 'RAW', data },
  });
}

// Marks a set of transactions-tab rows Cleared (only the Cleared column --
// leaves Reconciled/Reconciled Date untouched). Used by the reconcile
// mismatch flow's "clear existing transactions" option: instead of adding a
// brand-new transaction or a plug adjustment row, the user can pick
// something already logged but not yet cleared and clear it in place, then
// let the client re-run `calculate` to see the updated book balance. Mirrors
// markRowsReconciled's batchUpdate-of-single-cells shape.
async function markRowsCleared(sheets, map, rowNumbers) {
  if (!rowNumbers.length) return;
  const clearedCol = columnLetter(map['Cleared']);
  const data = rowNumbers.map((r) => ({
    range: `${RECONCILE_SHEETS.transactions}!${clearedCol}${r}`,
    values: [['Cleared']],
  }));
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: process.env.SHEET_ID,
    requestBody: { valueInputOption: 'RAW', data },
  });
}

async function unmarkRowsReconciled(sheets, map, rowNumbers) {
  if (!rowNumbers.length) return;
  const reconciledCol = columnLetter(map['Reconciled']);
  const reconciledDateCol = columnLetter(map['Reconciled Date']);
  const data = [];
  rowNumbers.forEach((r) => {
    data.push({ range: `${RECONCILE_SHEETS.transactions}!${reconciledCol}${r}`, values: [[false]] });
    data.push({ range: `${RECONCILE_SHEETS.transactions}!${reconciledDateCol}${r}`, values: [['']] });
  });
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: process.env.SHEET_ID,
    requestBody: { valueInputOption: 'RAW', data },
  });
}

// Appends a synthetic "Reconciliation" plug transaction for the delta
// between book balance and statement amount.
async function appendAdjustmentRow(sheets, map, amountHeader, payeeHeader, { account, type, amount, date }) {
  const spreadsheetId = process.env.SHEET_ID;
  const width = Math.max(...Object.values(map)) + 1;
  const row = new Array(width).fill('');

  if (payeeHeader) row[map[payeeHeader]] = 'Reconciliation';
  if ('Income/Expense' in map) row[map['Income/Expense']] = type;
  if ('SOF' in map) row[map['SOF']] = account;
  if ('Date' in map) row[map['Date']] = dateToSerial(date);
  if ('Month' in map) row[map['Month']] = dateToSerial(billingMonthForDate(date));
  if ('Cleared' in map) row[map['Cleared']] = 'Cleared';
  const expense = type === 'Expense' ? amount : 0;
  const income = type === 'Income' ? amount : 0;
  if ('Amount' in map) row[map['Amount']] = amount;
  if ('Expense' in map) row[map['Expense']] = expense;
  if ('Income' in map) row[map['Income']] = income;
  if (amountHeader === 'Total' && 'Total' in map) row[map['Total']] = expense - income;
  if ('Notes' in map) row[map['Notes']] = 'Auto-inserted to reconcile against statement';

  const response = await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${RECONCILE_SHEETS.transactions}!A:${columnLetter(width - 1)}`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [row] },
  });
  const updatedRange = response.data.updates.updatedRange; // e.g. "transactions!A57:K57"
  const rowNumber = parseInt(updatedRange.match(/(\d+)(?::|$)/)[1], 10);
  return rowNumber;
}

// Appends a real, un-reconciled Cleared transaction -- something forgotten
// from the sheet. Reconciled/Reconciled Date deliberately left blank so it
// flows through the normal matching logic on the next recalculation.
async function appendPlainTransactionRow(sheets, map, amountHeader, payeeHeader, { name, sof, type, amount, date, month }) {
  const spreadsheetId = process.env.SHEET_ID;
  const width = Math.max(...Object.values(map)) + 1;
  const row = new Array(width).fill('');

  if (payeeHeader) row[map[payeeHeader]] = name;
  if ('Income/Expense' in map) row[map['Income/Expense']] = type;
  if ('SOF' in map) row[map['SOF']] = sof;
  if ('Date' in map) row[map['Date']] = dateToSerial(date);
  if ('Month' in map) row[map['Month']] = dateToSerial(month || billingMonthForDate(date));
  if ('Cleared' in map) row[map['Cleared']] = 'Cleared';
  const expense = type === 'Expense' ? amount : 0;
  const income = type === 'Income' ? amount : 0;
  if ('Amount' in map) row[map['Amount']] = amount;
  if ('Expense' in map) row[map['Expense']] = expense;
  if ('Income' in map) row[map['Income']] = income;
  if (amountHeader === 'Total' && 'Total' in map) row[map['Total']] = expense - income;
  if ('Notes' in map) row[map['Notes']] = 'Added during reconciliation';

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${RECONCILE_SHEETS.transactions}!A:${columnLetter(width - 1)}`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [row] },
  });
}

// Growing a sheet's *data* (values.update/append) does NOT grow its
// underlying grid -- the grid has its own fixed rowCount/columnCount, and
// writing to a cell outside that grid fails outright ("Range ... exceeds
// grid limits"), it doesn't auto-expand. Self-provisioning a brand new
// column can walk right off the edge of a grid that happens to be sized to
// exactly fit the existing headers (as this transactions tab's was: 16
// columns, A:P, with no spare column for this PR's new "Payment ID").
// Widen the grid first via an appendDimension batchUpdate -- the same
// spreadsheets.batchUpdate surface getOrCreateLogSheet already uses to add
// a whole new tab -- so the header write below always lands inside it.
async function ensureSheetColumnCount(sheets, spreadsheetId, sheetName, requiredColumnCount) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties' });
  const sheet = (meta.data.sheets || []).find((s) => s.properties.title === sheetName);
  if (!sheet) throw new Error(`Sheet "${sheetName}" not found`);
  const currentColumnCount = (sheet.properties.gridProperties && sheet.properties.gridProperties.columnCount) || 0;
  if (currentColumnCount >= requiredColumnCount) return;
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{
        appendDimension: {
          sheetId: sheet.properties.sheetId,
          dimension: 'COLUMNS',
          length: requiredColumnCount - currentColumnCount,
        },
      }],
    },
  });
}

// Ensures `headerName` exists on the transactions tab's header row,
// appending it as a new self-provisioned column (same pattern as the
// Reconciled / Reconciled Date columns Reconcile.gs auto-added on its own
// first run -- see "Self-provisioned columns" in the project's onboarding
// doc) if it isn't there yet. Returns a possibly-updated header map;
// callers must use the returned map, not the one they passed in.
async function getOrCreateTransactionsColumn(sheets, map, headerName) {
  if (headerName in map) return map;
  const spreadsheetId = process.env.SHEET_ID;
  const nextIndex = Object.keys(map).length ? Math.max(...Object.values(map)) + 1 : 0;
  await ensureSheetColumnCount(sheets, spreadsheetId, RECONCILE_SHEETS.transactions, nextIndex + 1);
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${RECONCILE_SHEETS.transactions}!${columnLetter(nextIndex)}1`,
    valueInputOption: 'RAW',
    requestBody: { values: [[headerName]] },
  });
  return { ...map, [headerName]: nextIndex };
}

function generatePaymentId() {
  return `pay_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function shiftMonth(date, deltaMonths) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + deltaMonths, 1));
}

// Mirrors Payments.gs's "Log Credit Card Payment" macro (see
// claude/MNAB-project-state.md): writes TWO Transfer-tagged legs for one
// card payment -- an Expense on the paying (cash) account and an Income on
// the card -- so both accounts' balances reflect the payment while the
// existing Diary SUMIF/reconciliation math still excludes it from
// spend/income aggregation via the sheet's own "<>TRUE" Transfer criteria,
// same as a desktop-logged payment. A shared, self-provisioned "Payment ID"
// column links the two rows so undo-payment can find and delete both later
// -- transactions have no other reliable shared key once dates/amounts/
// payees can be edited independently after the fact. Does NOT itself flip
// the card's Diary "Billed" row to "Paid" -- see tryFlipDiaryBilledToPaid
// below, called separately by actionPayCard after this succeeds.
async function appendCardPaymentRows(sheets, { cardAccount, cashAccount, amount, date, month }) {
  const spreadsheetId = process.env.SHEET_ID;
  let map = await getHeaderMap(sheets, spreadsheetId, RECONCILE_SHEETS.transactions);
  requireColumns(map, 'transactions', ['SOF', 'Date', 'Cleared']);
  const amountHeader = 'Total' in map ? 'Total' : 'Amount';
  if (!(amountHeader in map)) throw new Error('transactions tab needs a "Total" or "Amount" column.');
  const payeeHeader = 'Payee' in map ? 'Payee' : ('Name' in map ? 'Name' : null);

  map = await getOrCreateTransactionsColumn(sheets, map, 'Transfer');
  map = await getOrCreateTransactionsColumn(sheets, map, 'Payment ID');

  const paymentId = generatePaymentId();
  const dateSerial = dateToSerial(date);
  const monthSerial = dateToSerial(month);

  function buildLeg(sof, type, payeeText) {
    const width = Math.max(...Object.values(map)) + 1;
    const row = new Array(width).fill('');
    if (payeeHeader) row[map[payeeHeader]] = payeeText;
    if ('Income/Expense' in map) row[map['Income/Expense']] = type;
    row[map['SOF']] = sof;
    row[map['Date']] = dateSerial;
    if ('Month' in map) row[map['Month']] = monthSerial;
    row[map['Cleared']] = 'Cleared';
    const expense = type === 'Expense' ? amount : 0;
    const income = type === 'Income' ? amount : 0;
    if ('Amount' in map) row[map['Amount']] = amount;
    if ('Expense' in map) row[map['Expense']] = expense;
    if ('Income' in map) row[map['Income']] = income;
    if (amountHeader === 'Total' && 'Total' in map) row[map['Total']] = expense - income;
    if ('Notes' in map) row[map['Notes']] = 'Card payment';
    row[map['Transfer']] = true;
    row[map['Payment ID']] = paymentId;
    return row;
  }

  const cashLeg = buildLeg(cashAccount, 'Expense', `Payment to ${cardAccount}`);
  const cardLeg = buildLeg(cardAccount, 'Income', `Payment from ${cashAccount}`);
  const width = Math.max(...Object.values(map)) + 1;
  const range = `${RECONCILE_SHEETS.transactions}!A:${columnLetter(width - 1)}`;

  // Two sequential appends (rather than one two-row append) so each
  // response's updatedRange cleanly yields that leg's own row number --
  // mirrors appendAdjustmentRow's single-row-append-then-parse pattern.
  const cashResp = await sheets.spreadsheets.values.append({
    spreadsheetId,
    range,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [cashLeg] },
  });
  const cashRowNumber = parseInt(cashResp.data.updates.updatedRange.match(/(\d+)(?::|$)/)[1], 10);

  const cardResp = await sheets.spreadsheets.values.append({
    spreadsheetId,
    range,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [cardLeg] },
  });
  const cardRowNumber = parseInt(cardResp.data.updates.updatedRange.match(/(\d+)(?::|$)/)[1], 10);

  return { paymentId, cashRowNumber, cardRowNumber };
}

// Shared read of the Diary tab, used by both tryFlipDiaryBilledToPaid (a
// write) and getDiaryBilledAmount (read-only, for the Add Payment form's
// amount pre-fill) below. Deliberately just a fetch + light validation, with
// no matching/write logic of its own, so neither of those two callers ends
// up routed through the other -- each stays a single, independent read of
// this same snapshot, avoiding any call-back-into-each-other cycle between
// the write path and the read-only lookup as this file grows. Returns null
// (never throws) if the sheet or its required columns aren't there.
async function fetchDiarySheet(sheets) {
  const spreadsheetId = process.env.SHEET_ID;
  const sheetName = 'Diary';
  let map;
  try {
    map = await getHeaderMap(sheets, spreadsheetId, sheetName);
  } catch (err) {
    return null;
  }
  if (!('Name' in map) || !('Month' in map)) return null;

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetName}!A2:Z`,
    valueRenderOption: 'UNFORMATTED_VALUE',
  });
  return { spreadsheetId, sheetName, map, values: response.data.values || [] };
}

// Pure matcher over a fetchDiarySheet() result -- Name == cardAccount
// (Diary's bill rows are named after the card, same as any other budget
// line item there) + Month, and an optional Status filter (case-insensitive).
function findDiaryRowMatch(diarySheet, { cardAccount, month, status }) {
  if (!diarySheet) return null;
  const { map, values } = diarySheet;
  if (status && !('Status' in map)) return null;
  const monthSerial = dateToSerial(month);

  for (let i = 0; i < values.length; i++) {
    const row = values[i];
    const name = row[map['Name']];
    if (!name || String(name).trim().toLowerCase() !== cardAccount.trim().toLowerCase()) continue;
    if (row[map['Month']] !== monthSerial) continue;
    if (status && String(row[map['Status']] || '').trim().toLowerCase() !== status.toLowerCase()) continue;
    return { rowNumber: i + 2, row };
  }
  return null;
}

// Best-effort mirror of Payments.gs's other behavior (see
// claude/MNAB-project-state.md and GitHub issue #8): if this card has a
// Diary line item for the billing month being paid, currently "Billed", and
// the payment covers it (amountPaid >= that row's Expense amount - 0.5,
// matching this project's documented "whole-statement-only" assumption --
// no partial-payment tracking), flip its Status to "Paid". Matches by Name
// == cardAccount + Month + Status=Billed (see findDiaryRowMatch above).
//
// Deliberately silent/non-fatal on anything that doesn't match cleanly (no
// Diary sheet, missing columns, no matching row, wrong status) -- this is a
// nice-to-have convenience, not something a guess-gone-wrong should ever be
// allowed to block the actual payment write, which already happened by the
// time this runs. Returns { flipped, reason? } so the caller can surface it.
async function tryFlipDiaryBilledToPaid(sheets, { cardAccount, month, amountPaid }) {
  const diarySheet = await fetchDiarySheet(sheets);
  if (!diarySheet) return { flipped: false, reason: 'no-diary-sheet' };
  if (!('Status' in diarySheet.map)) return { flipped: false, reason: 'missing-columns' };

  const match = findDiaryRowMatch(diarySheet, { cardAccount, month, status: 'Billed' });
  if (!match) return { flipped: false, reason: 'no-match' };

  const billedAmount = 'Expense' in diarySheet.map ? Number(match.row[diarySheet.map['Expense']]) || 0 : 0;
  if (amountPaid < billedAmount - 0.5) return { flipped: false, reason: 'amount-below-billed' };

  await sheets.spreadsheets.values.update({
    spreadsheetId: diarySheet.spreadsheetId,
    range: `${diarySheet.sheetName}!${columnLetter(diarySheet.map['Status'])}${match.rowNumber}`,
    valueInputOption: 'RAW',
    requestBody: { values: [['Paid']] },
  });
  return { flipped: true, rowNumber: match.rowNumber };
}

// Reverse of tryFlipDiaryBilledToPaid above, for undo-payment (GitHub issue
// #37): actionPayCard's forward flip marks a Diary "Billed" line "Paid" once
// a payment covers it, but undoing that payment left the Diary line stuck on
// "Paid" with no corresponding transaction anymore. Matches by Name ==
// cardAccount + Month + Status=Paid (mirrors findDiaryRowMatch's other
// direction) and flips it back to "Billed". No amount check here -- unlike
// the forward flip, there's no partial-undo case to guard against; if the
// payment that caused the flip is being removed, the bill is unambiguously
// billed-but-unpaid again. Same best-effort/non-fatal contract as
// tryFlipDiaryBilledToPaid: never let a Diary-matching quirk block the
// undo, which already happened by the time this runs.
async function tryFlipDiaryPaidToBilled(sheets, { cardAccount, month }) {
  const diarySheet = await fetchDiarySheet(sheets);
  if (!diarySheet) return { flipped: false, reason: 'no-diary-sheet' };
  if (!('Status' in diarySheet.map)) return { flipped: false, reason: 'missing-columns' };

  const match = findDiaryRowMatch(diarySheet, { cardAccount, month, status: 'Paid' });
  if (!match) return { flipped: false, reason: 'no-match' };

  await sheets.spreadsheets.values.update({
    spreadsheetId: diarySheet.spreadsheetId,
    range: `${diarySheet.sheetName}!${columnLetter(diarySheet.map['Status'])}${match.rowNumber}`,
    valueInputOption: 'RAW',
    requestBody: { values: [['Billed']] },
  });
  return { flipped: true, rowNumber: match.rowNumber };
}

// Read-only counterpart used by the Add Payment form to pre-fill the amount
// field with what's actually billed for the selected month, instead of
// starting blank. Finds the card's Diary "Billed" line for that month and
// returns its Expense amount. Kept deliberately separate from (not routed
// through) tryFlipDiaryBilledToPaid above -- this never writes, has no
// amountPaid/already-covered guard, and can safely be called on every
// open/month-change without side effects; the two only share the
// fetch/match helpers, not each other.
async function getDiaryBilledAmount(sheets, { cardAccount, month }) {
  const diarySheet = await fetchDiarySheet(sheets);
  if (!diarySheet) return { found: false };
  if (!('Expense' in diarySheet.map)) return { found: false };

  const match = findDiaryRowMatch(diarySheet, { cardAccount, month, status: 'Billed' });
  if (!match) return { found: false };

  const amount = Number(match.row[diarySheet.map['Expense']]) || 0;
  return { found: true, amount };
}

// Finds every transactions-tab row tagged with `paymentId` and deletes them
// (highest row number first, so deleting one doesn't shift the row number of
// another still pending deletion in the same batch). Works even if only one
// leg is still findable (e.g. the other was already removed by hand) --
// callers surface `deletedCount` so the UI can say so.
//
// Also surfaces `cardAccount`/`month` (read off the Income leg -- see
// appendCardPaymentRows's buildLeg calls, the card side is always the
// 'Income' type) before anything is deleted, so the caller can pass them to
// tryFlipDiaryPaidToBilled (GitHub issue #37) without the client having to
// know or resend them. Both come back null if the Income leg isn't found or
// the sheet is missing the columns needed to read it -- same
// silent-degrade contract as the rest of this file's Diary-adjacent code.
async function deletePaymentRows(sheets, paymentId) {
  const spreadsheetId = process.env.SHEET_ID;
  const map = await getHeaderMap(sheets, spreadsheetId, RECONCILE_SHEETS.transactions);
  if (!('Payment ID' in map)) return { deletedCount: 0, cardAccount: null, month: null };

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${RECONCILE_SHEETS.transactions}!A2:Z`,
    valueRenderOption: 'UNFORMATTED_VALUE',
  });
  const values = response.data.values || [];
  const paymentIdCol = map['Payment ID'];
  const rowNumbers = [];
  let cardAccount = null;
  let month = null;
  values.forEach((row, i) => {
    if (String(row[paymentIdCol] || '').trim() !== String(paymentId).trim()) return;
    rowNumbers.push(i + 2);
    const isCardLeg = 'Income/Expense' in map && row[map['Income/Expense']] === 'Income';
    if (isCardLeg && !cardAccount) {
      if ('SOF' in map && row[map['SOF']]) cardAccount = String(row[map['SOF']]);
      if ('Month' in map && typeof row[map['Month']] === 'number') month = serialToDate(row[map['Month']]);
    }
  });

  rowNumbers.sort((a, b) => b - a);
  for (const rowNumber of rowNumbers) {
    await deleteSheetRow(sheets, RECONCILE_SHEETS.transactions, rowNumber);
  }

  return { deletedCount: rowNumbers.length, cardAccount, month };
}

async function updateAccountLastReconciled(sheets, accountsMap, rowNumber, asOfDate, statementAmount) {
  requireColumns(accountsMap, 'Accounts', ['Last Reconciled Through', 'Last Reconciled Statement']);
  const throughCol = columnLetter(accountsMap['Last Reconciled Through']);
  const stmtCol = columnLetter(accountsMap['Last Reconciled Statement']);
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: process.env.SHEET_ID,
    requestBody: {
      valueInputOption: 'RAW',
      data: [
        { range: `${RECONCILE_SHEETS.accounts}!${throughCol}${rowNumber}`, values: [[dateToSerial(asOfDate)]] },
        { range: `${RECONCILE_SHEETS.accounts}!${stmtCol}${rowNumber}`, values: [[statementAmount]] },
      ],
    },
  });
}

async function clearAccountLastReconciled(sheets, accountsMap, rowNumber) {
  const throughCol = columnLetter(accountsMap['Last Reconciled Through']);
  const stmtCol = columnLetter(accountsMap['Last Reconciled Statement']);
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: process.env.SHEET_ID,
    requestBody: {
      valueInputOption: 'RAW',
      data: [
        { range: `${RECONCILE_SHEETS.accounts}!${throughCol}${rowNumber}`, values: [['']] },
        { range: `${RECONCILE_SHEETS.accounts}!${stmtCol}${rowNumber}`, values: [['']] },
      ],
    },
  });
}

async function getOrCreateLogSheet(sheets) {
  const spreadsheetId = process.env.SHEET_ID;
  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties' });
  let sheet = (meta.data.sheets || []).find((s) => s.properties.title === RECONCILE_SHEETS.log);
  if (!sheet) {
    const addResponse = await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: RECONCILE_SHEETS.log } } }] },
    });
    sheet = addResponse.data.replies[0].addSheet;
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${RECONCILE_SHEETS.log}!A1:${columnLetter(RECONCILIATION_LOG_COLUMNS.length - 1)}1`,
      valueInputOption: 'RAW',
      requestBody: { values: [RECONCILIATION_LOG_COLUMNS] },
    });
  }
  const map = await getHeaderMap(sheets, spreadsheetId, RECONCILE_SHEETS.log);
  requireColumns(map, 'Reconciliations', RECONCILIATION_LOG_COLUMNS);
  return map;
}

async function logReconciliation(sheets, entry) {
  const spreadsheetId = process.env.SHEET_ID;
  const map = await getOrCreateLogSheet(sheets);
  const width = Math.max(...Object.values(map)) + 1;
  const row = new Array(width).fill('');

  row[map['Timestamp']] = dateToSerial(new Date());
  row[map['Account']] = entry.account;
  row[map['Period Start']] = dateToSerial(entry.periodStart);
  row[map['Period End']] = dateToSerial(entry.periodEnd);
  row[map['System Total']] = entry.systemTotal;
  row[map['Statement Amount']] = entry.statementAmount;
  row[map['Variance']] = entry.variance;
  row[map['Matched Count']] = entry.matchedCount;
  row[map['Adjustment Type']] = entry.adjustmentType || '';
  row[map['Adjustment Amount']] = entry.adjustmentAmount || '';
  row[map['Status']] = entry.status;

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${RECONCILE_SHEETS.log}!A:${columnLetter(width - 1)}`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [row] },
  });
}

async function getReconciliationLogRows(sheets, accountName) {
  const spreadsheetId = process.env.SHEET_ID;
  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties' });
  const sheetExists = (meta.data.sheets || []).some((s) => s.properties.title === RECONCILE_SHEETS.log);
  if (!sheetExists) return { map: null, rows: [] };

  const map = await getHeaderMap(sheets, spreadsheetId, RECONCILE_SHEETS.log);
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${RECONCILE_SHEETS.log}!A2:Z`,
    valueRenderOption: 'UNFORMATTED_VALUE',
  });
  const values = response.data.values || [];

  const rows = [];
  values.forEach((row, i) => {
    const account = row[map['Account']];
    if (!account || String(account).trim().toLowerCase() !== accountName.toLowerCase()) return;
    const periodStartSerial = row[map['Period Start']];
    const periodEndSerial = row[map['Period End']];
    rows.push({
      rowNumber: i + 2,
      timestampSerial: row[map['Timestamp']],
      account: String(account).trim(),
      periodStart: typeof periodStartSerial === 'number' ? serialToDate(periodStartSerial) : null,
      periodStartSerial,
      periodEnd: typeof periodEndSerial === 'number' ? serialToDate(periodEndSerial) : null,
      systemTotal: row[map['System Total']],
      statementAmount: row[map['Statement Amount']],
      variance: row[map['Variance']],
      matchedCount: row[map['Matched Count']],
      adjustmentType: row[map['Adjustment Type']] || '',
      adjustmentAmount: row[map['Adjustment Amount']] || 0,
      status: row[map['Status']],
    });
  });

  return { map, rows };
}

// Batched read of the Reconciliations tab returning, per account, the
// timestamp of its most recent reconciliation *action* (when it was
// actually performed/logged) -- distinct from Accounts' "Last Reconciled
// Through" (a user-chosen statement as-of date). One sheet read for every
// account, rather than getReconciliationLogRows()'s one-read-per-account
// (that function still exists for the single-account detail/undo flows).
// actionUndo deletes the corresponding log row on undo, so the max
// Timestamp per account here always reflects current state, no extra
// bookkeeping needed.
async function getLastReconciledTimestamps(sheets) {
  const spreadsheetId = process.env.SHEET_ID;
  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties' });
  const sheetExists = (meta.data.sheets || []).some((s) => s.properties.title === RECONCILE_SHEETS.log);
  if (!sheetExists) return {};

  const map = await getHeaderMap(sheets, spreadsheetId, RECONCILE_SHEETS.log);
  if (!('Account' in map) || !('Timestamp' in map)) return {};

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${RECONCILE_SHEETS.log}!A2:Z`,
    valueRenderOption: 'UNFORMATTED_VALUE',
  });
  const values = response.data.values || [];

  const latestSerial = {};
  values.forEach((row) => {
    const account = row[map['Account']];
    const timestampSerial = row[map['Timestamp']];
    if (!account || typeof timestampSerial !== 'number') return;
    const key = String(account).trim().toLowerCase();
    if (!(key in latestSerial) || timestampSerial > latestSerial[key]) latestSerial[key] = timestampSerial;
  });

  const result = {};
  Object.keys(latestSerial).forEach((key) => {
    result[key] = serialToDate(latestSerial[key]).toISOString();
  });
  return result;
}

async function deleteSheetRow(sheets, sheetName, rowNumber) {
  const spreadsheetId = process.env.SHEET_ID;
  const gridId = await getSheetGridId(sheets, spreadsheetId, sheetName);
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          deleteDimension: {
            range: { sheetId: gridId, dimension: 'ROWS', startIndex: rowNumber - 1, endIndex: rowNumber },
          },
        },
      ],
    },
  });
}

module.exports = {
  RECONCILE_SHEETS,
  RECONCILIATION_LOG_COLUMNS,
  round2,
  parseISODate,
  formatISODate,
  todayWIBDate,
  parseISOMonth,
  billingMonthForDate,
  fetchAccountsForReconcile,
  findAccount,
  fetchTransactionsForReconcile,
  sumClearedTransactions,
  sumCumulativeClearedTransactions,
  markRowsReconciled,
  markRowsCleared,
  unmarkRowsReconciled,
  appendAdjustmentRow,
  appendPlainTransactionRow,
  appendCardPaymentRows,
  tryFlipDiaryBilledToPaid,
  tryFlipDiaryPaidToBilled,
  getDiaryBilledAmount,
  deletePaymentRows,
  shiftMonth,
  updateAccountLastReconciled,
  clearAccountLastReconciled,
  logReconciliation,
  getReconciliationLogRows,
  getLastReconciledTimestamps,
  deleteSheetRow,
  getSheetsClient,
  getWriteSheetsClient,
};
