/**
 * @OnlyCurrentDoc
 *
 * InboxWebApp.gs — the write path into the MNAB Import Inbox.
 *
 * This is NOT part of the MNAB Apps Script project. It's bound to the
 * separate "MNAB Import Inbox" spreadsheet (owned by the personal account)
 * and deployed as a web app, so tools that stage transactions (Claude reading
 * bank screenshots, the UOB ONE cashback skill) can add rows to the inbox
 * without any Google connector.
 *
 * The @OnlyCurrentDoc line above limits this script's Google permission to
 * the spreadsheet it's bound to. It can't open MNAB or any other file, so the
 * worst a leaked secret can do is add rows to the inbox.
 *
 * Requests: HTTP POST, body is JSON. Every request carries the shared secret
 * (Script Properties › INBOX_SECRET) as "secret". Responses are JSON with
 * ok: true / false.
 *
 *   { "secret": "…", "action": "ping" }
 *       -> { ok, inboxRows }   checks the secret and the tab
 *
 *   { "secret": "…", "action": "list", "status": "Staged" }
 *       -> { ok, rows: [ { row, "Inbox ID", Payee, Date: "2026-11-26", … } ] }
 *       status is optional; omit it for every row.
 *
 *   { "secret": "…", "action": "stage", "dryRun": false,
 *     "allowDuplicates": false,
 *     "rows": [ {
 *       "payee": "GoFood - Fore Coffee",   required
 *       "type": "Expense",                 required: Expense | Income
 *       "sof": "uob one 8655",             required: the MNAB Accounts name
 *       "date": "26/11/2026",              required: dd/mm/yyyy or yyyy-mm-dd
 *       "amount": 54000,                   required: > 0, whole rupiah
 *       "month": "11/2026",                optional: mm/yyyy or yyyy-mm;
 *                                          blank = InboxImport works it out
 *       "cleared": "Cleared",              optional: Cleared (default) | Uncleared
 *       "transfer": false,                 optional
 *       "notes": "…",                      optional
 *       "kind": "Variable",                optional: Fixed | Variable
 *       "billId": "IB-12",                 optional
 *       "category": "Eating out",          optional, written only if the tab has
 *                                          a Category column
 *       "approve": true,                   optional, see AUTO_APPROVE_SOFS
 *       "deleteAfterImport": true          optional, default true
 *     } ] }
 *       -> { ok, staged: [ { index, inboxId, row } ],
 *            duplicates: [ { index, inboxId } ], errors: [ { index, error } ] }
 *
 * Checks on stage. Any row with an error is reported and nothing in that
 * request is written, so a request is all-or-nothing.
 *   - Required fields present and well formed (SOF names are checked later by
 *     InboxImport.gs, which can see the Accounts tab; this script can't).
 *   - Duplicates: a row whose SOF, Date, Amount and Payee all match a row
 *     already in the inbox is not staged again and comes back under
 *     "duplicates". Send allowDuplicates: true for real repeats (two identical
 *     coffees on one day).
 *   - Approve is kept ticked only for SOFs listed in Script Properties ›
 *     AUTO_APPROVE_SOFS (comma separated, default "uob one 8655"). Everything
 *     else lands unticked for review, so the scheduled auto-import never
 *     takes a row from anywhere else without you looking at it.
 *
 * Inbox IDs are INB-YYYYMMDD-NN (staging date, Jakarta). The last NN used per
 * day is kept in Script Properties, so an ID is never handed out twice, even
 * after imported rows are deleted from the inbox.
 *
 * Setup (once, at a computer):
 *   1. In the inbox spreadsheet: Extensions › Apps Script. Paste this file.
 *   2. Project Settings: time zone (GMT+07:00) Jakarta.
 *   3. Run setupInbox() from the editor. It creates or checks the `inbox` tab
 *      headers, creates INBOX_SECRET if there isn't one, and logs it
 *      (View › Logs / Execution log).
 *   4. Deploy › New deployment › Web app. Execute as: Me. Who has access:
 *      Anyone. Copy the /exec URL.
 *   5. Give the URL and the secret to whatever stages rows.
 * After changing this file: Deploy › Manage deployments › edit › New version,
 * so the same URL serves the new code.
 */

const INBOX_WEBAPP = {
  sheetName: 'inbox',
  timeZone: 'Asia/Jakarta',
  maxRowsPerRequest: 200,
  defaultAutoApproveSofs: 'uob one 8655',
  // Column headers, in the order setupInbox() creates them. Rows are always
  // written by header name, so moving columns around later is fine.
  headers: [
    'Inbox ID', 'Approve', 'Status', 'Payee', 'Income/Expense', 'SOF', 'Date',
    'Month', 'Cleared', 'Amount', 'Expense', 'Income', 'Total', 'Transfer',
    'Notes', 'Staged At', 'Imported At', 'Transactions Row', 'Kind', 'Bill ID',
    'Delete After Import',
  ],
  checkboxHeaders: ['Approve', 'Transfer', 'Delete After Import'],
};

// ---------------------------------------------------------------- entry points

function doPost(e) {
  let body;
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return inboxwa_json_({ ok: false, error: 'Body is not valid JSON.' });
  }
  if (!inboxwa_secretOk_(body.secret)) return inboxwa_json_({ ok: false, error: 'Bad secret.' });

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return inboxwa_json_({ ok: false, error: 'Busy, try again.' });
  try {
    switch (body.action) {
      case 'ping': return inboxwa_json_(inboxwa_ping_());
      case 'list': return inboxwa_json_(inboxwa_list_(body));
      case 'stage': return inboxwa_json_(inboxwa_stage_(body));
      default: return inboxwa_json_({ ok: false, error: 'Unknown action "' + body.action + '".' });
    }
  } catch (err) {
    return inboxwa_json_({ ok: false, error: String(err && err.message || err) });
  } finally {
    lock.releaseLock();
  }
}

/** A GET only says the app is up; it never returns data. */
function doGet() {
  return inboxwa_json_({ ok: true, service: 'MNAB Import Inbox', use: 'POST' });
}

/** Run once from the editor. Safe to rerun. */
function setupInbox() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(INBOX_WEBAPP.sheetName);
  if (!sheet) sheet = ss.insertSheet(INBOX_WEBAPP.sheetName);
  const width = Math.max(sheet.getLastColumn(), 1);
  const have = sheet.getRange(1, 1, 1, width).getValues()[0].map(function (h) { return String(h).trim(); });
  const missing = INBOX_WEBAPP.headers.filter(function (h) { return have.indexOf(h) === -1; });
  if (have.every(function (h) { return h === ''; })) {
    sheet.getRange(1, 1, 1, INBOX_WEBAPP.headers.length).setValues([INBOX_WEBAPP.headers]).setFontWeight('bold');
  } else if (missing.length) {
    const start = have.filter(function (h) { return h !== ''; }).length + 1;
    sheet.getRange(1, start, 1, missing.length).setValues([missing]).setFontWeight('bold');
  }
  sheet.setFrozenRows(1);

  const props = PropertiesService.getScriptProperties();
  let secret = props.getProperty('INBOX_SECRET');
  if (!secret) {
    secret = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
    props.setProperty('INBOX_SECRET', secret);
  }
  if (!props.getProperty('AUTO_APPROVE_SOFS')) {
    props.setProperty('AUTO_APPROVE_SOFS', INBOX_WEBAPP.defaultAutoApproveSofs);
  }
  Logger.log('Inbox tab ready' + (missing.length ? ' (added: ' + missing.join(', ') + ')' : '') + '.');
  Logger.log('INBOX_SECRET: ' + secret);
  Logger.log('AUTO_APPROVE_SOFS: ' + props.getProperty('AUTO_APPROVE_SOFS'));
}

// ---------------------------------------------------------------- actions

function inboxwa_ping_() {
  const sheet = inboxwa_sheet_();
  return { ok: true, inboxRows: Math.max(sheet.getLastRow() - 1, 0) };
}

function inboxwa_list_(body) {
  const sheet = inboxwa_sheet_();
  const col = inboxwa_headerMap_(sheet);
  const last = sheet.getLastRow();
  if (last < 2) return { ok: true, rows: [] };
  const headers = Object.keys(col);
  const want = body.status ? String(body.status).trim() : '';
  const rows = [];
  sheet.getRange(2, 1, last - 1, sheet.getLastColumn()).getValues().forEach(function (r, i) {
    if (inboxwa_blankRow_(r, col)) return;
    if (want && 'Status' in col && String(r[col['Status']]).trim() !== want) return;
    const out = { row: i + 2 };
    headers.forEach(function (h) {
      const v = r[col[h]];
      out[h] = v instanceof Date
        ? Utilities.formatDate(v, INBOX_WEBAPP.timeZone, h === 'Staged At' || h === 'Imported At' ? "yyyy-MM-dd'T'HH:mm" : 'yyyy-MM-dd')
        : v;
    });
    rows.push(out);
  });
  return { ok: true, rows: rows };
}

function inboxwa_stage_(body) {
  const input = Array.isArray(body.rows) ? body.rows : [];
  if (!input.length) return { ok: false, error: 'No rows.' };
  if (input.length > INBOX_WEBAPP.maxRowsPerRequest) {
    return { ok: false, error: 'At most ' + INBOX_WEBAPP.maxRowsPerRequest + ' rows per request.' };
  }

  const sheet = inboxwa_sheet_();
  const col = inboxwa_headerMap_(sheet);
  ['Inbox ID', 'Approve', 'Status', 'Payee', 'Income/Expense', 'SOF', 'Date', 'Amount'].forEach(function (h) {
    if (!(h in col)) throw new Error('Inbox is missing the "' + h + '" column. Run setupInbox().');
  });

  const autoApprove = inboxwa_autoApproveSofs_();
  const errors = [];
  const parsed = input.map(function (raw, index) {
    const res = inboxwa_parseRow_(raw || {}, autoApprove);
    if (res.error) errors.push({ index: index, error: res.error });
    return res.row;
  });
  if (errors.length) return { ok: false, error: 'Nothing staged: ' + errors.length + ' row(s) failed checks.', errors: errors };

  // Duplicates against what's already in the inbox, and within this request.
  const last = sheet.getLastRow();
  const existing = {};
  if (last >= 2) {
    sheet.getRange(2, 1, last - 1, sheet.getLastColumn()).getValues().forEach(function (r) {
      if (inboxwa_blankRow_(r, col)) return;
      const d = r[col['Date']];
      if (!(d instanceof Date)) return;
      existing[inboxwa_dupKey_(r[col['SOF']], d, r[col['Amount']], r[col['Payee']])] =
        String(r[col['Inbox ID']] || '').trim();
    });
  }
  const duplicates = [];
  const toWrite = [];
  parsed.forEach(function (p, index) {
    const key = inboxwa_dupKey_(p.sof, p.date, p.amount, p.payee);
    if (!body.allowDuplicates && key in existing) {
      duplicates.push({ index: index, inboxId: existing[key] || '(this request)' });
      return;
    }
    existing[key] = '';
    toWrite.push({ index: index, p: p });
  });

  if (body.dryRun) {
    return {
      ok: true, dryRun: true, wouldStage: toWrite.length, duplicates: duplicates, errors: [],
      approved: toWrite.filter(function (w) { return w.p.approve; }).length,
    };
  }
  if (!toWrite.length) return { ok: true, staged: [], duplicates: duplicates, errors: [] };

  // IDs, then one block write.
  const ids = inboxwa_nextIds_(sheet, col, toWrite.length);
  const width = sheet.getLastColumn();
  const startRow = Math.max(sheet.getLastRow(), 1) + 1;
  const now = new Date();
  const letter = function (h) { return inboxwa_colLetter_(col[h] + 1); };
  const block = toWrite.map(function (w, i) {
    const p = w.p;
    const rowNum = startRow + i;
    const row = new Array(width).fill('');
    const set = function (h, v) { if (h in col) row[col[h]] = v; };
    set('Inbox ID', ids[i]);
    set('Approve', p.approve);
    set('Status', 'Staged');
    set('Payee', p.payee);
    set('Income/Expense', p.type);
    set('SOF', p.sof);
    set('Date', p.date);
    set('Month', p.month || '');
    set('Cleared', p.cleared);
    set('Amount', p.amount);
    set('Transfer', p.transfer);
    set('Notes', p.notes);
    set('Staged At', now);
    set('Kind', p.kind);
    set('Bill ID', p.billId);
    set('Category', p.category);
    set('Delete After Import', p.deleteAfterImport);
    // Review-only formulas, same as the old inbox.
    const t = letter('Income/Expense') + rowNum;
    const a = letter('Amount') + rowNum;
    if ('Expense' in col) row[col['Expense']] = '=IF(' + t + '="Expense",' + a + ',0)';
    if ('Income' in col) row[col['Income']] = '=IF(' + t + '="Income",' + a + ',0)';
    if ('Total' in col && 'Expense' in col && 'Income' in col) {
      row[col['Total']] = '=' + letter('Expense') + rowNum + '-' + letter('Income') + rowNum;
    }
    return row;
  });
  sheet.getRange(startRow, 1, block.length, width).setValues(block);

  // Formats and checkboxes for the new rows.
  const n = block.length;
  const fmt = function (h, f) { if (h in col) sheet.getRange(startRow, col[h] + 1, n, 1).setNumberFormat(f); };
  fmt('Date', 'dd/mm/yyyy');
  fmt('Month', 'mmm yyyy');
  fmt('Amount', '#,##0');
  fmt('Expense', '#,##0');
  fmt('Income', '#,##0');
  fmt('Total', '#,##0');
  fmt('Staged At', 'dd/mm/yyyy hh:mm');
  fmt('Imported At', 'dd/mm/yyyy hh:mm');
  const checkbox = SpreadsheetApp.newDataValidation().requireCheckbox().build();
  INBOX_WEBAPP.checkboxHeaders.forEach(function (h) {
    if (h in col) sheet.getRange(startRow, col[h] + 1, n, 1).setDataValidation(checkbox);
  });
  SpreadsheetApp.flush();

  return {
    ok: true,
    staged: toWrite.map(function (w, i) { return { index: w.index, inboxId: ids[i], row: startRow + i, approved: w.p.approve }; }),
    duplicates: duplicates,
    errors: [],
  };
}

// ---------------------------------------------------------------- helpers

/** Validates one input row. Returns { row } or { error }. */
function inboxwa_parseRow_(raw, autoApprove) {
  const payee = String(raw.payee == null ? '' : raw.payee).trim();
  if (!payee) return { error: 'payee is required' };
  const type = String(raw.type || '').trim();
  if (type !== 'Expense' && type !== 'Income') return { error: 'type must be Expense or Income' };
  const sof = String(raw.sof || '').trim();
  if (!sof) return { error: 'sof is required' };
  const date = inboxwa_parseDate_(raw.date);
  if (!date) return { error: 'date must be dd/mm/yyyy or yyyy-mm-dd' };
  const amount = Number(raw.amount);
  if (!(amount > 0) || Math.round(amount) !== amount) return { error: 'amount must be a positive whole number' };
  let month = '';
  if (raw.month != null && String(raw.month).trim() !== '') {
    month = inboxwa_parseMonth_(raw.month);
    if (!month) return { error: 'month must be mm/yyyy or yyyy-mm' };
  }
  const clearedRaw = raw.cleared == null || raw.cleared === '' ? 'Cleared' : raw.cleared;
  let cleared;
  if (clearedRaw === true || clearedRaw === 'Cleared') cleared = 'Cleared';
  else if (clearedRaw === false || clearedRaw === 'Uncleared') cleared = 'Uncleared';
  else return { error: 'cleared must be Cleared or Uncleared' };
  const kind = String(raw.kind || '').trim();
  if (kind && kind !== 'Fixed' && kind !== 'Variable') return { error: 'kind must be Fixed or Variable' };
  const billId = String(raw.billId || '').trim().toUpperCase();
  if (billId && !/^IB-\d+$/.test(billId)) return { error: 'billId must look like IB-12' };
  return {
    row: {
      payee: payee, type: type, sof: sof, date: date, amount: amount, month: month,
      cleared: cleared, transfer: raw.transfer === true,
      notes: String(raw.notes == null ? '' : raw.notes),
      kind: kind, billId: billId,
      category: String(raw.category || '').trim(),
      approve: raw.approve === true && autoApprove[sof.toLowerCase()] === true,
      deleteAfterImport: raw.deleteAfterImport !== false,
    },
  };
}

/** dd/mm/yyyy or yyyy-mm-dd -> local Date at midnight, or null. */
function inboxwa_parseDate_(v) {
  const s = String(v == null ? '' : v).trim();
  let y, m, d, mt;
  if ((mt = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s))) { d = +mt[1]; m = +mt[2]; y = +mt[3]; }
  else if ((mt = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s))) { y = +mt[1]; m = +mt[2]; d = +mt[3]; }
  else return null;
  const date = new Date(y, m - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) return null;
  return date;
}

/** mm/yyyy or yyyy-mm -> Date on the 1st of that month, or null. */
function inboxwa_parseMonth_(v) {
  const s = String(v).trim();
  let y, m, mt;
  if ((mt = /^(\d{1,2})\/(\d{4})$/.exec(s))) { m = +mt[1]; y = +mt[2]; }
  else if ((mt = /^(\d{4})-(\d{2})$/.exec(s))) { y = +mt[1]; m = +mt[2]; }
  else return null;
  if (m < 1 || m > 12) return null;
  return new Date(y, m - 1, 1);
}

function inboxwa_dupKey_(sof, date, amount, payee) {
  return [
    String(sof).trim().toLowerCase(),
    date.getFullYear() + '-' + (date.getMonth() + 1) + '-' + date.getDate(),
    Number(amount),
    String(payee).trim().toLowerCase(),
  ].join('|');
}

/**
 * Hands out n new INB-YYYYMMDD-NN IDs for today (Jakarta). Starts after the
 * higher of the stored counter and any ID for today already in the sheet.
 */
function inboxwa_nextIds_(sheet, col, n) {
  const ymd = Utilities.formatDate(new Date(), INBOX_WEBAPP.timeZone, 'yyyyMMdd');
  const props = PropertiesService.getScriptProperties();
  const key = 'INB_SEQ_' + ymd;
  let lastUsed = Number(props.getProperty(key) || 0);
  const last = sheet.getLastRow();
  if (last >= 2) {
    const re = new RegExp('^INB-' + ymd + '-(\\d+)$');
    sheet.getRange(2, col['Inbox ID'] + 1, last - 1, 1).getValues().forEach(function (r) {
      const m = re.exec(String(r[0]).trim());
      if (m) lastUsed = Math.max(lastUsed, Number(m[1]));
    });
  }
  const ids = [];
  for (let i = 1; i <= n; i++) {
    const nn = lastUsed + i;
    ids.push('INB-' + ymd + '-' + (nn < 10 ? '0' + nn : String(nn)));
  }
  props.setProperty(key, String(lastUsed + n));
  return ids;
}

function inboxwa_autoApproveSofs_() {
  const raw = PropertiesService.getScriptProperties().getProperty('AUTO_APPROVE_SOFS');
  const list = (raw == null ? INBOX_WEBAPP.defaultAutoApproveSofs : raw).split(',');
  const out = {};
  list.forEach(function (s) { s = s.trim().toLowerCase(); if (s) out[s] = true; });
  return out;
}

function inboxwa_secretOk_(given) {
  const want = PropertiesService.getScriptProperties().getProperty('INBOX_SECRET') || '';
  const got = String(given || '');
  if (!want || got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ got.charCodeAt(i);
  return diff === 0;
}

function inboxwa_sheet_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(INBOX_WEBAPP.sheetName);
  if (!sheet) throw new Error('Tab "' + INBOX_WEBAPP.sheetName + '" not found. Run setupInbox().');
  return sheet;
}

function inboxwa_headerMap_(sheet) {
  const width = Math.max(sheet.getLastColumn(), 1);
  const map = {};
  sheet.getRange(1, 1, 1, width).getValues()[0].forEach(function (h, i) {
    h = String(h).trim();
    if (h && !(h in map)) map[h] = i;
  });
  return map;
}

function inboxwa_blankRow_(r, col) {
  return ['Inbox ID', 'Payee', 'Amount'].every(function (h) {
    return !(h in col) || String(r[col[h]] == null ? '' : r[col[h]]).trim() === '';
  });
}

function inboxwa_colLetter_(n) {
  let s = '';
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

function inboxwa_json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
