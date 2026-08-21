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

const { getSheetsClient, getWriteSheetsClient, getSheetGridId, serialToDate, dateToSerial } = require('./sheets');

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
    return {
      rowNumber: i + 2,
      sof: sofRaw ? String(sofRaw).trim() : '',
      date: typeof dateSerial === 'number' ? serialToDate(dateSerial) : null,
      cleared: clearedRaw,
      isCleared: clearedRaw.toLowerCase() === 'cleared',
      type,
      amount: Number(row[map[amountHeader]]) || 0,
      displayAmount,
      isReconciled: reconciledRaw === true,
      reconciledDate: typeof reconciledDateSerial === 'number' ? serialToDate(reconciledDateSerial) : null,
      payee: payeeHeader ? row[map[payeeHeader]] : '',
      notes: map['Notes'] !== undefined ? (row[map['Notes']] || '') : '',
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
  parseISOMonth,
  billingMonthForDate,
  fetchAccountsForReconcile,
  findAccount,
  fetchTransactionsForReconcile,
  sumClearedTransactions,
  sumCumulativeClearedTransactions,
  markRowsReconciled,
  unmarkRowsReconciled,
  appendAdjustmentRow,
  appendPlainTransactionRow,
  updateAccountLastReconciled,
  clearAccountLastReconciled,
  logReconciliation,
  getReconciliationLogRows,
  deleteSheetRow,
  getSheetsClient,
  getWriteSheetsClient,
};
