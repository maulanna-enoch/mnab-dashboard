/**
 * Kinds.gs — Fixed / Variable classification for `transactions`
 * (Debt Exit plan, WS1).
 *
 * Every transaction gets one Kind:
 *   Transfer  money moving between your own accounts (Transfer = TRUE),
 *             incl. both legs of a card statement payment
 *   Income    any other Income row
 *   Fixed     a bill or installment (has a Bill ID, or was auto-inserted
 *             by InstallmentsBills.gs)
 *   Variable  everything else: day-to-day spending, card swipes included
 *             on the day they happen. The weekly allowance counts only these.
 *
 * RULES, first match wins:
 *   1. Transfer = TRUE              -> Transfer   (Kind Rule "transfer")
 *   2. Income                       -> Income     ("income")
 *   3. Kind set by hand             -> as set     ("manual")
 *   4. Has a Bill ID (Source ID)    -> Fixed      ("bill")
 *      or Notes start "Auto-insert"              ("auto-insert")
 *   5. Payee has a Kind on the
 *      Payees tab (column "Kind")   -> that Kind  ("payee")
 *   6. Otherwise                    -> Variable   ("default")
 *
 * The same rules live in api/_lib/kinds.js (the dashboard). Change both.
 *
 * ── COLUMNS on `transactions` (added automatically) ─────────────────────
 *   Kind       the result.
 *   Kind Rule  which rule set it. Type Fixed or Variable into Kind yourself
 *              and either leave Kind Rule blank or write "manual": the row
 *              then keeps your choice through every rerun. (Rules 1–2 still
 *              win, so a row that becomes a transfer stops counting.)
 *   Source ID  the Bill ID. Not new: InstallmentsBills.gs already writes
 *              the bill's IB-n code here on every row it inserts, and the
 *              dashboard's transaction form can link a row to a bill.
 *
 * ── PAYEE OVERRIDES ─────────────────────────────────────────────────────
 * The Payees tab's "Kind" column (E). Set it on the dashboard's Payees
 * page, or type Fixed / Variable into the sheet. Blank = no override.
 *
 * ── WHO WRITES KIND ─────────────────────────────────────────────────────
 *   - the dashboard, on every save
 *   - EmailImport.gs and InboxImport.gs, as each row is written
 *   - Finances > Classify Transactions (Fixed / Variable)… — the backfill.
 *     Rerunnable: it rewrites every row's Kind from the rules above, except
 *     hand-set ones. Run it again after changing a payee override.
 *     It shows what will change, and asks before writing.
 * Rows written by other paths (InstallmentsBills.gs, card payments and
 * transfers from the dashboard) have a blank Kind until the next backfill.
 * The dashboard doesn't depend on the stored value; it recomputes Kind
 * from the same rules every time it reads.
 *
 * Depends on headerIndexMap(), ensureColumn() and payeeHeaderName() from
 * Reconcile.gs (apps-script/Reconciliations.gs).
 *
 * ── INSTALL ─────────────────────────────────────────────────────────────
 * Paste this as a NEW script file named `Kinds` (Deployer only replaces
 * files that already exist), then paste the updated EmailImport.gs,
 * InboxImport.gs and Reconciliations.gs (menu item). Reload the sheet and
 * run Finances > Classify Transactions (Fixed / Variable)… once.
 */

var KIND_COLUMN_NAME = 'Kind';
var KIND_RULE_COLUMN_NAME = 'Kind Rule';
var BILL_ID_COLUMN_NAME = 'Source ID';
var KINDS_ALL = ['Fixed', 'Variable', 'Transfer', 'Income'];
var KINDS_SPENDING = ['Fixed', 'Variable'];
var KINDS_PREVIEW_MAX = 25;
var KINDS_SUMMARY_MONTHS = 3;

// Looks like a card statement payment / transfer that isn't flagged
// Transfer. Never reclassified automatically: listed in the backfill
// dialog so you can fix the row (Convert to transfer in the dashboard).
var KINDS_SUSPECT_PAYEE_RE = /^\s*(payment|transfer|trf|pembayaran)\s+(to|from|ke|dari|kartu)\b|bill payment|card payment|pembayaran kartu/i;

// ── Rules ───────────────────────────────────────────────────────────────

function kinds_normalize_(v, allowed) {
  var s = String(v === null || v === undefined ? '' : v).trim().toLowerCase();
  var list = allowed || KINDS_ALL;
  for (var i = 0; i < list.length; i++) if (list[i].toLowerCase() === s) return list[i];
  return null;
}

function kinds_billId_(v) {
  var s = String(v === null || v === undefined ? '' : v).trim().toUpperCase();
  return /^IB-\d+$/.test(s) ? s : null;
}

function kinds_isManual_(storedKind, storedRule) {
  if (!kinds_normalize_(storedKind, KINDS_SPENDING)) return false;
  var rule = String(storedRule === null || storedRule === undefined ? '' : storedRule).trim().toLowerCase();
  return rule === '' || rule === 'manual';
}

/**
 * f: {type, isTransfer, billId, notes, payee, storedKind, storedRule}
 * payeeKinds: {lowercasedPayee: 'Fixed'|'Variable'}
 * Returns {kind, rule}. Pure — mirrors classifyKind() in api/_lib/kinds.js.
 */
function kinds_classify_(f, payeeKinds) {
  f = f || {};
  if (f.isTransfer) return { kind: 'Transfer', rule: 'transfer' };
  if (f.type === 'Income') return { kind: 'Income', rule: 'income' };
  if (kinds_isManual_(f.storedKind, f.storedRule)) {
    return { kind: kinds_normalize_(f.storedKind, KINDS_SPENDING), rule: 'manual' };
  }
  if (kinds_billId_(f.billId)) return { kind: 'Fixed', rule: 'bill' };
  if (/^\s*auto-insert\b/i.test(String(f.notes || ''))) return { kind: 'Fixed', rule: 'auto-insert' };
  var key = String(f.payee || '').trim().toLowerCase();
  if (payeeKinds && key && payeeKinds[key]) return { kind: payeeKinds[key], rule: 'payee' };
  return { kind: 'Variable', rule: 'default' };
}

function kinds_truthy_(v) {
  return v === true || String(v).trim().toUpperCase() === 'TRUE';
}

// ── Payee overrides ─────────────────────────────────────────────────────

var kindsPayeeCache_ = null;

/** {lowercasedPayee: 'Fixed'|'Variable'} from the Payees tab. Cached per run. */
function kinds_payeeKinds_(ss) {
  if (kindsPayeeCache_) return kindsPayeeCache_;
  var map = {};
  var sheet = (ss || SpreadsheetApp.getActiveSpreadsheet()).getSheetByName('Payees');
  if (sheet && sheet.getLastRow() >= 2) {
    var values = sheet.getRange(1, 1, sheet.getLastRow(), sheet.getLastColumn()).getValues();
    var headers = values[0].map(function (h) { return String(h || '').trim().toLowerCase(); });
    var nameCol = headers.indexOf('payee');
    if (nameCol === -1) nameCol = 0;
    var kindCol = headers.indexOf('kind');
    if (kindCol !== -1) {
      for (var i = 1; i < values.length; i++) {
        var name = String(values[i][nameCol] || '').trim().toLowerCase();
        var kind = kinds_normalize_(values[i][kindCol], KINDS_SPENDING);
        if (name && kind) map[name] = kind;
      }
    }
  }
  kindsPayeeCache_ = map;
  return map;
}

function resetKindsCache_() {
  kindsPayeeCache_ = null;
}

/** Adds Kind / Kind Rule to `transactions` if missing. */
function ensureKindColumns_(txnSheet) {
  ensureColumn(txnSheet, KIND_COLUMN_NAME);
  ensureColumn(txnSheet, KIND_RULE_COLUMN_NAME);
}

// ── Backfill ────────────────────────────────────────────────────────────

/** Menu entry point: Finances > Classify Transactions (Fixed / Variable)… */
function classifyTransactionHistory() {
  var ui = SpreadsheetApp.getUi();
  // EmailImport/PayeeRules hold the script lock, InboxImport the document
  // lock — take both so no import appends or edits rows mid-backfill.
  var scriptLock = LockService.getScriptLock();
  var docLock = LockService.getDocumentLock();
  if (!scriptLock.tryLock(30000)) { ui.alert('Another import or script is running. Try again in a moment.'); return; }
  if (!docLock.tryLock(30000)) { scriptLock.releaseLock(); ui.alert('Another import or script is running. Try again in a moment.'); return; }
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(RECONCILE_CONFIG.transactionsSheet);
    if (!sheet) throw new Error('transactions tab not found.');
    ensureKindColumns_(sheet);
    resetKindsCache_();

    var plan = kinds_plan_(sheet, kinds_payeeKinds_(ss));
    var msg = kinds_describePlan_(plan);
    if (!plan.changes.length) {
      ui.alert('Classify transactions', 'Every row is already classified.\n\n' + msg, ui.ButtonSet.OK);
      return;
    }
    if (ui.alert('Classify transactions', msg + '\n\nWrite these changes?', ui.ButtonSet.YES_NO) !== ui.Button.YES) return;

    // Re-plan from a fresh read: rows could have moved while the dialog
    // was open (e.g. a delete from the dashboard), and the write is by
    // position.
    var fresh = kinds_plan_(sheet, kinds_payeeKinds_(ss));
    if (fresh.rows) {
      sheet.getRange(2, fresh.kindCol + 1, fresh.rows, 1).setValues(fresh.kindValues);
      sheet.getRange(2, fresh.ruleCol + 1, fresh.rows, 1).setValues(fresh.ruleValues);
    }
    ui.alert('Classify transactions', 'Updated ' + fresh.changes.length + ' row(s).', ui.ButtonSet.OK);
  } catch (err) {
    ui.alert('Classify transactions failed', String(err && err.message || err), ui.ButtonSet.OK);
  } finally {
    docLock.releaseLock();
    scriptLock.releaseLock();
  }
}

/**
 * Reads `transactions` and works out every row's Kind. Returns the new
 * Kind / Kind Rule column values (unchanged rows keep theirs), the list of
 * changes, counts, a per-billing-month summary and rows that look like
 * unflagged card payments.
 */
function kinds_plan_(sheet, payeeKinds) {
  var col = headerIndexMap(sheet);
  var payeeHeader = payeeHeaderName(col);
  var kindCol = col[KIND_COLUMN_NAME];
  var ruleCol = col[KIND_RULE_COLUMN_NAME];
  var lastRow = sheet.getLastRow();
  var plan = {
    kindCol: kindCol, ruleCol: ruleCol, rows: Math.max(lastRow - 1, 0),
    kindValues: [], ruleValues: [], changes: [], counts: {}, byMonth: {}, suspects: []
  };
  if (lastRow < 2) return plan;
  var values = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
  function get(r, h) { return h && h in col ? r[col[h]] : ''; }

  values.forEach(function (r, i) {
    var storedKind = r[kindCol];
    var storedRule = r[ruleCol];
    var payee = payeeHeader ? String(r[col[payeeHeader]] || '').trim() : '';
    var amount = Number(get(r, 'Amount')) || 0;
    if (!payee && !amount) { // blank row — leave as is
      plan.kindValues.push([storedKind]);
      plan.ruleValues.push([storedRule]);
      return;
    }
    var type = String(get(r, 'Income/Expense')).trim() === 'Income' ? 'Income' : 'Expense';
    var res = kinds_classify_({
      type: type,
      isTransfer: kinds_truthy_(get(r, 'Transfer')),
      billId: get(r, BILL_ID_COLUMN_NAME),
      notes: get(r, 'Notes'),
      payee: payee,
      storedKind: storedKind,
      storedRule: storedRule
    }, payeeKinds);
    plan.kindValues.push([res.kind]);
    plan.ruleValues.push([res.rule]);
    plan.counts[res.kind] = (plan.counts[res.kind] || 0) + 1;
    if (String(storedKind || '') !== res.kind || String(storedRule || '') !== res.rule) {
      plan.changes.push({ row: i + 2, payee: payee, from: storedKind || '(blank)', to: res.kind, rule: res.rule });
    }

    var month = get(r, 'Month');
    if (month && typeof month.getFullYear === 'function' && !isNaN(month.getTime())) {
      var key = month.getFullYear() + '-' + ('0' + (month.getMonth() + 1)).slice(-2);
      var m = plan.byMonth[key] || (plan.byMonth[key] = { Fixed: 0, Variable: 0, Transfer: 0, Income: 0 });
      m[res.kind] += amount;
    }
    if (res.kind === 'Variable' && KINDS_SUSPECT_PAYEE_RE.test(payee + ' ' + String(get(r, 'Notes') || ''))) {
      plan.suspects.push('Row ' + (i + 2) + ': ' + payee);
    }
  });
  return plan;
}

function kinds_describePlan_(plan) {
  var parts = [];
  parts.push('Rows by kind: ' + KINDS_ALL.map(function (k) { return k + ' ' + (plan.counts[k] || 0); }).join(', ') + '.');
  if (plan.changes.length) {
    var lines = plan.changes.slice(0, KINDS_PREVIEW_MAX).map(function (c) {
      return 'Row ' + c.row + ' ' + c.payee + ': ' + c.from + ' → ' + c.to + ' (' + c.rule + ')';
    });
    if (plan.changes.length > KINDS_PREVIEW_MAX) lines.push('…and ' + (plan.changes.length - KINDS_PREVIEW_MAX) + ' more.');
    parts.push(plan.changes.length + ' row(s) will change:\n' + lines.join('\n'));
  }
  var months = Object.keys(plan.byMonth).sort().reverse().slice(0, KINDS_SUMMARY_MONTHS);
  if (months.length) {
    parts.push('By billing month (Rp):\n' + months.map(function (k) {
      var m = plan.byMonth[k];
      return k + '  Fixed ' + m.Fixed.toLocaleString('id-ID') + ' · Variable ' + m.Variable.toLocaleString('id-ID') +
        ' · Transfer ' + m.Transfer.toLocaleString('id-ID');
    }).join('\n'));
  }
  if (plan.suspects.length) {
    var s = plan.suspects.slice(0, KINDS_PREVIEW_MAX);
    if (plan.suspects.length > KINDS_PREVIEW_MAX) s.push('…and ' + (plan.suspects.length - KINDS_PREVIEW_MAX) + ' more.');
    parts.push(plan.suspects.length + ' Variable row(s) look like a card payment or transfer but aren\'t marked Transfer, ' +
      'so they count as spending. Check them (Convert to transfer in the dashboard):\n' + s.join('\n'));
  }
  return parts.join('\n\n');
}
