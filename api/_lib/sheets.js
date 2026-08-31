const { google } = require('googleapis');

// Bills use a far-future placeholder end date (e.g. Dec 2099) in the sheet to
// mean "recurring, doesn't really end" -- as opposed to Installments, which
// have a real payoff date. Anything ending in/after this year is a Bill.
const BILL_YEAR_THRESHOLD = 2099;

// Google Sheets serial-date epoch is Dec 30, 1899.
function serialToDate(serial) {
  const epoch = Date.UTC(1899, 11, 30);
  return new Date(epoch + serial * 24 * 60 * 60 * 1000);
}

function dateToSerial(date) {
  const epoch = Date.UTC(1899, 11, 30);
  return Math.round((date.getTime() - epoch) / (24 * 60 * 60 * 1000));
}

// Finds the numeric grid sheetId for a tab by name -- needed for row-delete
// batchUpdate requests, which address sheets by id rather than name.
async function getSheetGridId(sheets, spreadsheetId, sheetName) {
  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets.properties',
  });
  const sheet = (meta.data.sheets || []).find((s) => s.properties.title === sheetName);
  if (!sheet) throw new Error(`Sheet "${sheetName}" not found`);
  return sheet.properties.sheetId;
}

function monthKey(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function monthLabel(key) {
  const [y, m] = key.split('-');
  return `${MONTH_NAMES[parseInt(m, 10) - 1]} ${y}`;
}

function getSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  return google.sheets({ version: 'v4', auth });
}

// Separate write-capable client (Editor access, full spreadsheets scope) --
// only ever used by the transaction-write endpoints. Every other endpoint in
// this app uses getSheetsClient() above and can never write.
function getWriteSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_WRITE_SERVICE_ACCOUNT_EMAIL,
      private_key: (process.env.GOOGLE_WRITE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

async function fetchAccountRows() {
  const sheets = getSheetsClient();

  // Columns: Name, Type
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SHEET_ID,
    range: 'Accounts!A2:B',
    valueRenderOption: 'UNFORMATTED_VALUE',
  });

  const rows = response.data.values || [];

  return rows
    .filter((row) => row[0])
    .map((row) => ({ name: row[0], type: row[1] || '' }));
}

async function fetchInstallmentRows() {
  const sheets = getSheetsClient();

  // Columns: Name, SOF, Amount, is_active, Ends, Starts, Months, Remarks, day of month
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SHEET_ID,
    range: 'installmentsbills!A2:I',
    // Without this, Sheets returns the *displayed* text (e.g. "Rp 5.000.000"),
    // which parseFloat can't read. This returns the underlying raw number/boolean.
    valueRenderOption: 'UNFORMATTED_VALUE',
  });

  const rows = response.data.values || [];

  return rows.map((row) => {
    const name = row[0] || '(unnamed)';
    const amount = parseFloat(row[2]) || 0;
    const isActiveRaw = row[3];
    const isActive = isActiveRaw === true || isActiveRaw === 'TRUE' || isActiveRaw === 'true';
    const endsSerial = row[4];
    const hasEndDate = typeof endsSerial === 'number';
    const endDate = hasEndDate ? serialToDate(endsSerial) : null;
    const isBill = hasEndDate && endDate.getUTCFullYear() >= BILL_YEAR_THRESHOLD;

    return { name, amount, isActive, hasEndDate, endDate, isBill };
  });
}

async function fetchDiaryRows() {
  const sheets = getSheetsClient();

  // Columns: Name, Income/Expense, Date, Month, Status, amountDefault, Expense,
  // Income, Category, amountVariable.
  //
  // amountDefault (F) is just the template/planned figure. Expense (G) and
  // Income (H) are the real amounts -- each equals amountDefault +
  // amountVariable (J), where amountVariable is a SUMIF pulled from a
  // separate transactions tab. G is populated for Expense rows, H for
  // Income rows.
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SHEET_ID,
    range: 'Diary!A2:J',
    valueRenderOption: 'UNFORMATTED_VALUE',
  });

  const rows = response.data.values || [];

  return rows.map((row) => {
    const name = row[0] || '(unnamed)';
    const type = row[1] === 'Income' ? 'Income' : 'Expense';
    const monthSerial = row[3];
    const hasMonth = typeof monthSerial === 'number';
    const monthDate = hasMonth ? serialToDate(monthSerial) : null;
    const status = (row[4] || '').toString().trim();
    const statusLower = status.toLowerCase();
    // Three statuses: "Paid" (settled), "Billed" (statement closed, amount
    // is final/known), "Unbilled" (still accruing, amount is an estimate).
    // Anything unrecognized falls back to "unbilled" so it reads as an
    // estimate rather than silently disappearing.
    const isPaid = statusLower === 'paid';
    const isBilled = statusLower === 'billed';
    const isUnbilled = !isPaid && !isBilled;
    const statusKey = isPaid ? 'paid' : isBilled ? 'billed' : 'unbilled';
    const amountDefault = parseFloat(row[5]) || 0;
    const expenseAmount = parseFloat(row[6]) || 0;
    const incomeAmount = parseFloat(row[7]) || 0;
    const category = row[8] || 'Uncategorized';
    const amountVariable = parseFloat(row[9]) || 0;
    const amount = type === 'Income' ? incomeAmount : expenseAmount;

    return {
      name,
      type,
      monthDate,
      month: hasMonth ? monthKey(monthDate) : null,
      status,
      statusKey,
      isPaid,
      isBilled,
      isUnbilled,
      amount,
      amountDefault,
      amountVariable,
      category,
    };
  });
}

async function fetchTransactionRows() {
  const sheets = getSheetsClient();

  // Columns: Payee, Income/Expense, SOF, Date, Month, Cleared, Amount,
  // Expense, Income, Total, Notes. rowNumber (1-based sheet row, accounting
  // for the header row) is included so edit/delete endpoints know which row
  // to target.
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SHEET_ID,
    range: 'transactions!A2:K',
    valueRenderOption: 'UNFORMATTED_VALUE',
  });

  const rows = response.data.values || [];
  const result = [];

  rows.forEach((row, i) => {
    if (!row[0]) return; // skip blank rows

    const payee = row[0];
    const type = row[1] === 'Income' ? 'Income' : 'Expense';
    const sof = row[2] || '';
    const dateSerial = row[3];
    const hasDate = typeof dateSerial === 'number';
    const date = hasDate ? serialToDate(dateSerial) : null;
    const monthSerial = row[4];
    const hasMonth = typeof monthSerial === 'number';
    const monthDate = hasMonth ? serialToDate(monthSerial) : null;
    const clearedRaw = (row[5] || '').toString().trim();
    const isCleared = clearedRaw.toLowerCase() === 'cleared';
    const amount = parseFloat(row[6]) || 0;
    const notes = row[10] || '';

    result.push({
      rowNumber: i + 2,
      payee,
      type,
      sof,
      date,
      hasDate,
      month: hasMonth ? monthKey(monthDate) : null,
      cleared: clearedRaw,
      isCleared,
      amount,
      notes,
    });
  });

  return result;
}

// Builds a full A:K row array for the `transactions` tab. Expense/Income/
// Total mirror the sheet's own formula logic (confirmed with the user):
// Expense = Amount if type is Expense else 0, Income = Amount if type is
// Income else 0, Total = Expense - Income. Written explicitly rather than
// left blank, since API-appended rows aren't guaranteed to inherit a Table's
// auto-fill formulas.
function buildTransactionRow({ payee, type, sof, dateSerial, monthSerial, cleared, amount, notes }) {
  const expense = type === 'Expense' ? amount : 0;
  const income = type === 'Income' ? amount : 0;
  const total = expense - income;
  return [payee, type, sof, dateSerial, monthSerial, cleared, amount, expense, income, total, notes || ''];
}

// See issue #52. `Payees` is a brand-new tab (not one auto-provisioned by
// legacy Apps Script), so -- like Accounts/transactions/etc. -- it uses a
// plain fixed A:D range rather than header-name lookup; header-name lookup
// in this codebase is reserved for columns Reconcile.gs bolted on after the
// fact in an unpredictable order (see MNAB-project-state.md).
//
// Columns: Payee, Lat, Lon, Updated At (Updated At is an audit trail for
// coordinate edits only -- it's never read back for logic).
const PAYEES_RANGE = 'Payees!A2:D';

function normalizePayeeName(name) {
  return String(name || '').trim().toLowerCase();
}

// `sheetsClient` is optional -- pass the write client when a caller already
// has one open (e.g. mid-upsert) so the read-then-write stays on one
// authenticated client; falls back to the read-only client otherwise.
async function fetchPayeeRows(sheetsClient) {
  const sheets = sheetsClient || getSheetsClient();
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SHEET_ID,
    range: PAYEES_RANGE,
    valueRenderOption: 'UNFORMATTED_VALUE',
  });

  const rows = response.data.values || [];
  const result = [];
  rows.forEach((row, i) => {
    const name = (row[0] || '').toString().trim();
    if (!name) return;
    const lat = row[1] === '' || row[1] === undefined ? null : Number(row[1]);
    const lon = row[2] === '' || row[2] === undefined ? null : Number(row[2]);
    result.push({
      rowNumber: i + 2,
      name,
      lat: Number.isFinite(lat) ? lat : null,
      lon: Number.isFinite(lon) ? lon : null,
      updatedAt: row[3] || '',
    });
  });
  return result;
}

function findPayeeRow(rows, name) {
  const key = normalizePayeeName(name);
  return rows.find((r) => normalizePayeeName(r.name) === key) || null;
}

// Ensures a `Payees` row exists for `name` -- appends one (existence-only,
// blank coordinates) if it's not there yet. If `lat`/`lon` are both finite
// numbers, also (over)writes that row's coordinates, stamping `Updated At`.
// This one function backs both call sites: transactions-add.js's automatic
// per-save upsert (existence always; coords only when captured AND the
// location-pin toggle was left on) and the Payees page's manual-override
// "Save" action (coords always; existence as a side effect for a
// never-transacted payee being pre-seeded).
async function upsertPayee(writeSheetsClient, { name, lat, lon }) {
  const trimmedName = String(name || '').trim();
  if (!trimmedName) return;

  const hasCoords = Number.isFinite(lat) && Number.isFinite(lon);
  const rows = await fetchPayeeRows(writeSheetsClient);
  const existing = findPayeeRow(rows, trimmedName);

  if (existing) {
    if (!hasCoords) return; // row already exists, no coordinate to write -- nothing to do
    await writeSheetsClient.spreadsheets.values.update({
      spreadsheetId: process.env.SHEET_ID,
      range: `Payees!B${existing.rowNumber}:D${existing.rowNumber}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[lat, lon, new Date().toISOString()]] },
    });
    return;
  }

  const row = hasCoords
    ? [trimmedName, lat, lon, new Date().toISOString()]
    : [trimmedName, '', '', ''];
  await writeSheetsClient.spreadsheets.values.append({
    spreadsheetId: process.env.SHEET_ID,
    range: 'Payees!A:D',
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [row] },
  });
}

// Manual "Clear location" action on the Payees page. No-op if the payee
// has no row at all (nothing to clear).
async function clearPayeeCoords(writeSheetsClient, name) {
  const rows = await fetchPayeeRows(writeSheetsClient);
  const existing = findPayeeRow(rows, name);
  if (!existing) return;
  await writeSheetsClient.spreadsheets.values.update({
    spreadsheetId: process.env.SHEET_ID,
    range: `Payees!B${existing.rowNumber}:D${existing.rowNumber}`,
    valueInputOption: 'RAW',
    requestBody: { values: [['', '', '']] },
  });
}

module.exports = {
  fetchInstallmentRows,
  fetchDiaryRows,
  fetchAccountRows,
  fetchTransactionRows,
  buildTransactionRow,
  fetchPayeeRows,
  findPayeeRow,
  upsertPayee,
  clearPayeeCoords,
  normalizePayeeName,
  getSheetsClient,
  getWriteSheetsClient,
  getSheetGridId,
  serialToDate,
  dateToSerial,
  monthKey,
  monthLabel,
  BILL_YEAR_THRESHOLD,
};
