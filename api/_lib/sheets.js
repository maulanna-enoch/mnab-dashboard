const { google } = require('googleapis');
const { wrapClient } = require('./read-batcher');
const { SETTINGS_RANGE, parseSettings } = require('./settings');
const {
  KIND_COLUMN,
  KIND_RULE_COLUMN,
  BILL_ID_COLUMN,
  classifyKind,
  payeeKindMap,
  normalizeSpendingKind,
} = require('./kinds');
const { BILL_YEAR_THRESHOLD, resolveKind, totalMonths } = require('./bills');
const {
  CATEGORY_COLUMN,
  CATEGORY_RULE_COLUMN,
  CATEGORIES_RANGE,
  DEFAULT_CATEGORIES,
  parseCategoryRows,
  buildCategoryContext,
  classifyCategory,
  normalizeCategoryName,
} = require('./categories');

// BILL_YEAR_THRESHOLD (from ./bills): a far-future Ends (e.g. Dec 2099)
// means "recurring, doesn't really end". Since WS2 a row's Kind column says
// whether it's a bill or an installment; the year is only the fallback for
// rows with no Kind set. See api/_lib/bills.js.

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

// Both clients are built once per warm function instance and shared, so
// every helper that calls getSheetsClient() on its own still goes through the
// same read batcher (./read-batcher.js): concurrent values.get calls become
// one values.batchGet, i.e. one read against the 60/min/user Sheets quota.
let readClient = null;
let writeClient = null;

function getSheetsClient() {
  if (readClient) return readClient;
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  readClient = wrapClient(google.sheets({ version: 'v4', auth }));
  return readClient;
}

// Separate write-capable client (Editor access, full spreadsheets scope) --
// only ever used by the transaction-write endpoints. Every other endpoint in
// this app uses getSheetsClient() above and can never write.
function getWriteSheetsClient() {
  if (writeClient) return writeClient;
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_WRITE_SERVICE_ACCOUNT_EMAIL,
      private_key: (process.env.GOOGLE_WRITE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  writeClient = wrapClient(google.sheets({ version: 'v4', auth }));
  return writeClient;
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

  // Columns: Name, SOF, Amount, is_active, Ends, Starts, Months, Remarks,
  // day of month -- by position. Plus `ID` (the permanent IB-n code), which
  // InstallmentsBills.gs self-provisions at the end, so it's found by header
  // name: the read starts at row 1 for that and is widened past column I.
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SHEET_ID,
    range: 'installmentsbills!A1:Z',
    // Without this, Sheets returns the *displayed* text (e.g. "Rp 5.000.000"),
    // which parseFloat can't read. This returns the underlying raw number/boolean.
    valueRenderOption: 'UNFORMATTED_VALUE',
  });

  const all = response.data.values || [];
  const headers = (all[0] || []).map((h) => String(h || '').trim());
  const idIdx = headers.indexOf('ID');
  // WS2: Cash bill / Card bill / Installment, self-provisioned by
  // InstallmentsBills.gs (Finances > Setup > Bill Kinds…). Blank -> fallback.
  const kindIdx = headers.indexOf('Kind');
  // Category system (C2): the bill's category, added by Categories.gs
  // (Finances > Setup > Categories…). Blank -> none.
  const categoryIdx = headers.indexOf('Category');
  const rows = all.slice(1);

  return rows.map((row) => {
    const name = row[0] || '(unnamed)';
    const amount = parseFloat(row[2]) || 0;
    const isActiveRaw = row[3];
    const isActive = isActiveRaw === true || isActiveRaw === 'TRUE' || isActiveRaw === 'true';
    const endsSerial = row[4];
    const hasEndDate = typeof endsSerial === 'number';
    const endDate = hasEndDate ? serialToDate(endsSerial) : null;
    const { kind, kindSet, isBill } = resolveKind(kindIdx >= 0 ? row[kindIdx] : '', endDate);
    const sof = String(row[1] || '').trim();
    const startsSerial = row[5];
    const startDate = typeof startsSerial === 'number' ? serialToDate(startsSerial) : null;
    const dayOfMonth = Number(row[8]) || null;
    const id = idIdx >= 0 && row[idIdx] ? String(row[idIdx]).trim() : null;
    const category = categoryIdx >= 0 && row[categoryIdx] ? String(row[categoryIdx]).trim().replace(/\s+/g, ' ') : null;

    const out = { id, name, sof, amount, isActive, hasEndDate, endDate, startDate, dayOfMonth, isBill, kind, kindSet, category };
    out.totalMonths = totalMonths(out);
    return out;
  });
}

// Reads the header row (row 1) of a tab and returns a { headerName: index0 }
// map -- same pattern api/_lib/reconcile.js already uses for its own
// self-provisioned columns (Reconciled, Reconciled Date, Transfer, Payment
// ID), kept as its own copy here rather than shared to avoid touching that
// already-working, self-contained module. Used for columns like `Pending`
// (see EmailImport.gs / issue #38) that land at an unpredictable position
// after the fixed A:K columns other functions in this file assume.
async function getHeaderMap(sheets, spreadsheetId, sheetName) {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetName}!1:1`,
    valueRenderOption: 'UNFORMATTED_VALUE',
  });
  return headerMapFromRow(response.data.values && response.data.values[0]);
}

function headerMapFromRow(headers) {
  const map = {};
  (headers || []).forEach((h, i) => {
    if (h !== undefined && h !== null && h !== '') map[String(h).trim()] = i;
  });
  return map;
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

async function fetchTransactionRows() {
  const sheets = getSheetsClient();
  const spreadsheetId = process.env.SHEET_ID;

  // `Pending` (see EmailImport.gs / issue #38) is a self-provisioned column
  // that may not exist at all yet (a sheet that's never had EmailImport.gs
  // run on it) and, once it does, lands somewhere after the fixed A:K
  // columns below -- read by header name and defaulted to "not pending"
  // when missing, same graceful-fallback convention as Reconciled/Transfer
  // elsewhere in this app.
  //
  // Header and data come from one read (row 1 onwards) rather than a header
  // read followed by a data read: one fewer request against the Sheets
  // quota, and nothing is awaited before the read, so it batches with
  // whatever the caller fires alongside it (see ./read-batcher.js).
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: 'transactions!A1:AZ',
    valueRenderOption: 'UNFORMATTED_VALUE',
  });
  const all = response.data.values || [];
  const headerMap = headerMapFromRow(all[0]);
  const pendingIdx = headerMap['Pending'];
  const hasPendingColumn = pendingIdx !== undefined;
  // Match ID / Match Status: self-provisioned by EmailImport.gs (issue #51)
  // once an import proposes a match against a manual entry -- same
  // graceful-fallback convention as Pending above (defaults to "no match").
  const matchIdIdx = headerMap['Match ID'];
  const matchStatusIdx = headerMap['Match Status'];
  // Transfer / Payment ID: self-provisioned by a card payment (Add Payment,
  // or "Convert to card payment" on the edit sheet) -- same graceful
  // fallback, defaults to "not a payment leg".
  const transferIdx = headerMap['Transfer'];
  const paymentIdIdx = headerMap['Payment ID'];
  // WS1: Kind / Kind Rule (see api/_lib/kinds.js) and Source ID, the Bill
  // ID InstallmentsBills.gs stamps on rows it inserts. Same fallback: a
  // missing column reads as blank.
  const kindIdx = headerMap[KIND_COLUMN];
  const kindRuleIdx = headerMap[KIND_RULE_COLUMN];
  const billIdIdx = headerMap[BILL_ID_COLUMN];
  // Category system (C1): Category / Category Rule, see
  // api/_lib/categories.js. Same fallback.
  const categoryIdx = headerMap[CATEGORY_COLUMN];
  const categoryRuleIdx = headerMap[CATEGORY_RULE_COLUMN];

  // Columns: Payee, Income/Expense, SOF, Date, Month, Cleared, Amount,
  // Expense, Income, Total, Notes. rowNumber (1-based sheet row, accounting
  // for the header row) is included so edit/delete endpoints know which row
  // to target. Widened from A2:K to A2:Z so self-provisioned trailing
  // columns like Pending are actually within the fetched range, then to
  // A:AZ once WS1's Kind columns pushed the header row past column W. The
  // read itself is at the top of this function, from row 1.
  const rows = all.slice(1);
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
    const pendingRaw = hasPendingColumn ? row[pendingIdx] : undefined;
    const isPending = pendingRaw === true || pendingRaw === 'TRUE' || pendingRaw === 'true';
    const matchIdRaw = matchIdIdx !== undefined ? row[matchIdIdx] : undefined;
    const matchStatusRaw = matchStatusIdx !== undefined ? row[matchStatusIdx] : undefined;
    const transferRaw = transferIdx !== undefined ? row[transferIdx] : undefined;
    const paymentIdRaw = paymentIdIdx !== undefined ? row[paymentIdIdx] : undefined;
    const cell = (idx) => (idx !== undefined && row[idx] !== undefined && row[idx] !== null ? String(row[idx]).trim() : '');

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
      isPending,
      matchId: matchIdRaw ? String(matchIdRaw).trim() : null,
      matchStatus: matchStatusRaw ? String(matchStatusRaw).trim() : null,
      isTransfer: transferRaw === true || transferRaw === 'TRUE' || transferRaw === 'true',
      paymentId: paymentIdRaw ? String(paymentIdRaw).trim() : null,
      storedKind: cell(kindIdx) || null,
      storedKindRule: cell(kindRuleIdx) || null,
      billId: cell(billIdIdx) || null,
      storedCategory: cell(categoryIdx) || null,
      storedCategoryRule: cell(categoryRuleIdx) || null,
    });
  });

  return result;
}

// Adds the effective `kind` / `kindRule` to rows from fetchTransactionRows()
// (see api/_lib/kinds.js). `payeeKinds` comes from payeeKindMap().
function classifyTransactionRow(r, payeeKinds) {
  return classifyKind({
    type: r.type,
    isTransfer: r.isTransfer,
    billId: r.billId,
    notes: r.notes,
    payee: r.payee,
    storedKind: r.storedKind,
    storedRule: r.storedKindRule,
  }, payeeKinds);
}

// Adds the effective `category` / `categoryGroup` / `categoryRule` to a row
// from fetchTransactionRows() (see api/_lib/categories.js). `ctx` comes from
// buildCategoryContext().
function classifyTransactionCategory(r, ctx) {
  return classifyCategory({
    type: r.type,
    isTransfer: r.isTransfer,
    billId: r.billId,
    notes: r.notes,
    payee: r.payee,
    storedCategory: r.storedCategory,
    storedCategoryRule: r.storedCategoryRule,
  }, ctx);
}

// { 'IB-3': 'Utilities', … } from fetchInstallmentRows() rows: each bill's
// category, for category rule 3 (a row copied from a bill gets its
// category).
function billCategoryMap(billRows) {
  const out = {};
  (billRows || []).forEach((b) => {
    if (b.id && b.category) out[String(b.id).trim().toUpperCase()] = b.category;
  });
  return out;
}

// fetchTransactionRows() plus each row's effective Kind and Category --
// what every fixed/variable consumer (the weekly budget, WS4 onwards) and
// every category consumer (Where it went, WS8) should read. Three extra
// small reads, in parallel: the Payees tab (Kind and Category defaults),
// the Categories tab and installmentsbills (bill categories).
async function fetchClassifiedTransactionRows() {
  const [rows, payees, cats, bills] = await Promise.all([
    fetchTransactionRows(),
    fetchPayeeRows(),
    fetchCategoryRows(),
    fetchInstallmentRows(),
  ]);
  const payeeKinds = payeeKindMap(payees);
  const ctx = buildCategoryContext(cats.categories, payees, billCategoryMap(bills));
  rows.forEach((r) => {
    const { kind, rule } = classifyTransactionRow(r, payeeKinds);
    r.kind = kind;
    r.kindRule = rule;
    const cat = classifyTransactionCategory(r, ctx);
    r.category = cat.category;
    r.categoryGroup = cat.group;
    r.categoryRule = cat.rule;
  });
  return rows;
}

// The Categories tab (apps-script/Categories.gs), A:F by position like
// Payees. Missing or empty tab -> the built-in DEFAULT_CATEGORIES, with
// fromTab false so a page can say so.
async function fetchCategoryRows(sheetsClient) {
  const sheets = sheetsClient || getSheetsClient();
  let values = null;
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.SHEET_ID,
      range: CATEGORIES_RANGE,
      valueRenderOption: 'UNFORMATTED_VALUE',
    });
    values = response.data.values || [];
  } catch (err) {
    const msg = String((err && err.message) || '');
    if (!/unable to parse range/i.test(msg)) throw err;
  }
  const parsed = values ? parseCategoryRows(values) : [];
  if (!parsed.length) return { categories: DEFAULT_CATEGORIES, fromTab: false };
  return { categories: parsed, fromTab: true };
}

// Makes sure every header in `names` exists on the transactions tab,
// appending missing ones at the end (adding grid columns if the tab is
// full). Same self-provisioning pattern as getOrCreateTransactionsColumn in
// api/_lib/reconcile.js. Returns the updated header map.
async function ensureTransactionsColumns(sheets, headerMap, names) {
  const missing = names.filter((n) => headerMap[n] === undefined);
  if (!missing.length) return headerMap;
  const spreadsheetId = process.env.SHEET_ID;
  const map = { ...headerMap };
  let next = Object.keys(map).length ? Math.max(...Object.values(map)) + 1 : 0;
  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties' });
  const tab = (meta.data.sheets || []).find((t) => t.properties.title === 'transactions');
  if (!tab) throw new Error('Sheet "transactions" not found');
  const have = (tab.properties.gridProperties && tab.properties.gridProperties.columnCount) || 0;
  const need = next + missing.length;
  if (have < need) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ appendDimension: { sheetId: tab.properties.sheetId, dimension: 'COLUMNS', length: need - have } }] },
    });
  }
  const data = missing.map((name) => {
    map[name] = next;
    return { range: `transactions!${columnLetter(next++)}1`, values: [[name]] };
  });
  await sheets.spreadsheets.values.batchUpdate({ spreadsheetId, requestBody: { valueInputOption: 'RAW', data } });
  return map;
}

// Everything classifyCategory() needs, read fresh for a write: the
// Categories tab, payee defaults and bill categories, in parallel.
async function fetchCategoryContext(sheetsClient) {
  const sheets = sheetsClient || getSheetsClient();
  const [cats, payees, bills] = await Promise.all([
    fetchCategoryRows(sheets),
    fetchPayeeRows(sheets),
    fetchInstallmentRows(),
  ]);
  return buildCategoryContext(cats.categories, payees, billCategoryMap(bills));
}

// Writes one row's Category / Category Rule (categoryCells() output),
// adding the two columns if this sheet doesn't have them yet.
async function writeTransactionCategory(sheets, headerMap, rowNumber, { category, rule }) {
  const map = await ensureTransactionsColumns(sheets, headerMap, [CATEGORY_COLUMN, CATEGORY_RULE_COLUMN]);
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: process.env.SHEET_ID,
    requestBody: {
      valueInputOption: 'RAW',
      data: [
        { range: `transactions!${columnLetter(map[CATEGORY_COLUMN])}${rowNumber}`, values: [[category || '']] },
        { range: `transactions!${columnLetter(map[CATEGORY_RULE_COLUMN])}${rowNumber}`, values: [[rule || '']] },
      ],
    },
  });
  return map;
}

// Writes Kind / Kind Rule (and, when `billId` is not undefined, Source ID
// -- '' clears it) onto one transactions row. Provisions the columns first.
async function writeTransactionKind(sheets, headerMap, rowNumber, { kind, rule, billId }) {
  const names = [KIND_COLUMN, KIND_RULE_COLUMN];
  if (billId !== undefined) names.push(BILL_ID_COLUMN);
  const map = await ensureTransactionsColumns(sheets, headerMap, names);
  const data = [
    { range: `transactions!${columnLetter(map[KIND_COLUMN])}${rowNumber}`, values: [[kind]] },
    { range: `transactions!${columnLetter(map[KIND_RULE_COLUMN])}${rowNumber}`, values: [[rule]] },
  ];
  if (billId !== undefined) {
    data.push({ range: `transactions!${columnLetter(map[BILL_ID_COLUMN])}${rowNumber}`, values: [[billId || '']] });
  }
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: process.env.SHEET_ID,
    requestBody: { valueInputOption: 'RAW', data },
  });
  return map;
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
// coordinate edits only -- it's never read back for logic), Kind (WS1):
// an optional Fixed / Variable override for every transaction with this
// payee -- see api/_lib/kinds.js. Blank = no override -- and Category (F,
// Category system C1): the payee's default category, see
// api/_lib/categories.js. Blank = none.
const PAYEES_RANGE = 'Payees!A2:F';
const PAYEES_KIND_HEADER_CELL = 'Payees!E1';
const PAYEES_CATEGORY_HEADER_CELL = 'Payees!F1';

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
      kind: normalizeSpendingKind(row[4]),
      category: row[5] === undefined || row[5] === null ? '' : String(row[5]).trim().replace(/\s+/g, ' '),
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

// Payees page "Kind" picker (WS1): sets or clears (kind = null) one payee's
// Fixed / Variable override, adding the payee row if it isn't there yet and
// the `Kind` header in E1 the first time.
async function setPayeeKind(writeSheetsClient, name, kind) {
  const trimmedName = String(name || '').trim();
  if (!trimmedName) return;
  const value = normalizeSpendingKind(kind) || '';
  const spreadsheetId = process.env.SHEET_ID;
  const header = await writeSheetsClient.spreadsheets.values.get({ spreadsheetId, range: PAYEES_KIND_HEADER_CELL });
  if (!((header.data.values || [])[0] || [])[0]) {
    await writeSheetsClient.spreadsheets.values.update({
      spreadsheetId,
      range: PAYEES_KIND_HEADER_CELL,
      valueInputOption: 'RAW',
      requestBody: { values: [['Kind']] },
    });
  }
  let existing = findPayeeRow(await fetchPayeeRows(writeSheetsClient), trimmedName);
  if (!existing) {
    if (!value) return; // nothing to clear on a payee that doesn't exist
    await upsertPayee(writeSheetsClient, { name: trimmedName });
    existing = findPayeeRow(await fetchPayeeRows(writeSheetsClient), trimmedName);
    if (!existing) throw new Error(`Couldn't add payee "${trimmedName}"`);
  }
  await writeSheetsClient.spreadsheets.values.update({
    spreadsheetId,
    range: `Payees!E${existing.rowNumber}`,
    valueInputOption: 'RAW',
    requestBody: { values: [[value]] },
  });
}

// A payee's default category (Category system C3), Payees column F. A
// blank / null category clears it. Adds the payee row if it's missing and a
// category is being set; puts the F1 header in if it isn't there yet.
async function setPayeeCategory(writeSheetsClient, name, category) {
  const trimmedName = String(name || '').trim();
  if (!trimmedName) return;
  const value = normalizeCategoryName(category);
  const spreadsheetId = process.env.SHEET_ID;
  const header = await writeSheetsClient.spreadsheets.values.get({ spreadsheetId, range: PAYEES_CATEGORY_HEADER_CELL });
  if (!((header.data.values || [])[0] || [])[0]) {
    await writeSheetsClient.spreadsheets.values.update({
      spreadsheetId,
      range: PAYEES_CATEGORY_HEADER_CELL,
      valueInputOption: 'RAW',
      requestBody: { values: [['Category']] },
    });
  }
  let existing = findPayeeRow(await fetchPayeeRows(writeSheetsClient), trimmedName);
  if (!existing) {
    if (!value) return;
    await upsertPayee(writeSheetsClient, { name: trimmedName });
    existing = findPayeeRow(await fetchPayeeRows(writeSheetsClient), trimmedName);
    if (!existing) throw new Error(`Couldn't add payee "${trimmedName}"`);
  }
  await writeSheetsClient.spreadsheets.values.update({
    spreadsheetId,
    range: `Payees!F${existing.rowNumber}`,
    valueInputOption: 'RAW',
    requestBody: { values: [[value]] },
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

// Settings tab (WS0) -- key/value list read by key; parsing lives in
// ./settings.js. A missing tab is not an error: every setting falls back to
// its default and a warning says so.
async function fetchSettings(sheetsClient) {
  const sheets = sheetsClient || getSheetsClient();
  let rows;
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.SHEET_ID,
      range: SETTINGS_RANGE,
      valueRenderOption: 'UNFORMATTED_VALUE',
    });
    rows = response.data.values || [];
  } catch (err) {
    const msg = String((err && err.message) || '');
    if (/unable to parse range/i.test(msg)) rows = null;
    else throw err;
  }
  return parseSettings(rows);
}

// Steals log (apps-script/Steals.gs) -- the actual hole (WS6). Columns are
// found by header name (Date, Direction, Type, Source, Amount), so the tab's
// column order doesn't matter. Returns null when the tab doesn't exist yet.
// Dates come back as 'YYYY-MM-DD' built from the serial's calendar parts.
async function fetchStealsRows(sheetsClient) {
  const sheets = sheetsClient || getSheetsClient();
  let all;
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.SHEET_ID,
      range: 'Steals!A1:Z',
      valueRenderOption: 'UNFORMATTED_VALUE',
    });
    all = response.data.values || [];
  } catch (err) {
    const msg = String((err && err.message) || '');
    if (/unable to parse range/i.test(msg)) return null;
    throw err;
  }
  const headers = (all[0] || []).map((h) => String(h || '').trim().toLowerCase());
  const idx = (name) => headers.indexOf(name);
  // Due Date is optional (WS8 push reminders); older tabs don't have it.
  const col = { date: idx('date'), direction: idx('direction'), type: idx('type'), source: idx('source'), amount: idx('amount'), dueDate: idx('due date') };
  if (col.date < 0 || col.direction < 0 || col.type < 0 || col.amount < 0) {
    throw new Error('The "Steals" tab is missing a Date, Direction, Type or Amount column.');
  }
  const pad = (n) => String(n).padStart(2, '0');
  const isoFromSerial = (raw) => {
    if (typeof raw !== 'number' || !(raw > 0)) return null;
    const d = serialToDate(Math.floor(raw));
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  };
  return all.slice(1).map((row, i) => {
    const date = isoFromSerial(row[col.date]);
    const dueDate = col.dueDate >= 0 ? isoFromSerial(row[col.dueDate]) : null;
    const amount = typeof row[col.amount] === 'number' ? row[col.amount] : parseFloat(row[col.amount]);
    return {
      rowNumber: i + 2,
      date,
      direction: String(row[col.direction] || '').trim(),
      type: String(row[col.type] || '').trim(),
      source: col.source >= 0 ? String(row[col.source] || '').trim() : '',
      amount: Number.isFinite(amount) ? amount : 0,
      dueDate,
    };
  }).filter((r) => r.direction || r.amount);
}

module.exports = {
  fetchStealsRows,
  fetchSettings,
  fetchInstallmentRows,
  fetchAccountRows,
  fetchTransactionRows,
  fetchClassifiedTransactionRows,
  classifyTransactionRow,
  classifyTransactionCategory,
  billCategoryMap,
  fetchCategoryRows,
  fetchCategoryContext,
  writeTransactionCategory,
  setPayeeCategory,
  ensureTransactionsColumns,
  writeTransactionKind,
  buildTransactionRow,
  fetchPayeeRows,
  findPayeeRow,
  upsertPayee,
  clearPayeeCoords,
  setPayeeKind,
  normalizePayeeName,
  getSheetsClient,
  getWriteSheetsClient,
  getSheetGridId,
  getHeaderMap,
  columnLetter,
  serialToDate,
  dateToSerial,
  monthKey,
  monthLabel,
  BILL_YEAR_THRESHOLD,
};
