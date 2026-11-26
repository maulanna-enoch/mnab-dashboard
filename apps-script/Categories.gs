/**
 * Categories.gs — what each transaction was for (Category system, C1).
 *
 * Kind (Kinds.gs) says whether a row is a commitment: Fixed, Variable,
 * Transfer or Income. Category says what the money was for: Eating out,
 * Ride-hailing, School fees… The two are independent: a Vidio
 * subscription is Fixed + Subscriptions, a GoFood order is Variable +
 * Food delivery.
 *
 * Two levels: each category belongs to one Group. A row has one category
 * (no split transactions). The `Income` group's categories are only for
 * Income rows; every other group's only for Expense rows.
 *
 * RULES, first match wins:
 *   1. Transfer = TRUE                 -> none        (Category Rule "transfer")
 *   2. Category set by hand            -> as set      ("manual")
 *   3. Linked to a bill (Source ID)
 *      whose installmentsbills row
 *      has a Category                  -> the bill's  ("bill")
 *   4. Set by a payee rule             -> as set      ("rule …", e.g. "rule #50")
 *   5. Payee has a Category on the
 *      Payees tab (column F)           -> that one    ("payee")
 *   6. Notes carry a bank label from
 *      the Categories tab's Bank Labels -> that one   ("bank-label")
 *   7. Otherwise                       -> Expense: Uncategorised, Income: blank
 *                                                     ("default")
 * A stored category only counts (rules 2 and 4) when its name is on the
 * Categories tab and fits the row's type.
 *
 * The same rules live in api/_lib/categories.js (the dashboard). Change
 * both together.
 *
 * ── THE TAB ─────────────────────────────────────────────────────────────
 * Finances > Setup > Categories… creates `Categories` with the starter
 * list (rerunnable: it only adds what's missing and never changes a row
 * you edited). Columns:
 *   Name         the category. Renaming one doesn't rewrite old rows yet.
 *   Group        e.g. Food & Drink. "Income" is reserved for income.
 *   Colour       a hex colour for the dashboard. Blank = the group's.
 *   Order        pickers sort by this. Blank = last.
 *   Active       untick to hide it from pickers. Rows already using it
 *                keep it.
 *   Bank Labels  the category names the bank apps print in Notes, e.g.
 *                "Makanan dan Minuman". Several: separate with ";".
 *
 * ── COLUMNS (added by setup) ────────────────────────────────────────────
 *   transactions  Category, Category Rule. Type a category into Category
 *                 yourself and leave Category Rule blank (or "manual"): it
 *                 then always wins over the automatic rules.
 *   Payees        Category in column F (next to Kind in E): the payee's
 *                 default category.
 *
 *   installmentsbills  Category: the bill's category. Rows copied from that
 *                 bill (Source ID = its IB-n) get it.
 *   PayeeRules    Set Category (PayeeRules.gs): the category a matching
 *                 rule gives a row, stored with Category Rule "rule #n".
 * Setup also puts a dropdown of your categories on those three columns
 * (Payees F, installmentsbills Category, PayeeRules Set Category). It only
 * warns on a name that isn't on the list; it doesn't block it.
 *
 * WHO WRITES CATEGORY (C2): email imports (EmailImport.gs), inbox imports
 * (InboxImport.gs; a Category staged in the inbox counts as set by hand),
 * the bills copy (InstallmentsBills.gs) and Apply Payee Rules to All Rows
 * (PayeeRules.gs) all write Category + Category Rule from these rules. The
 * dashboard form (C3) writes them too, and Finances > Setup > Categorise
 * Transactions… (C4, below) backfills every existing row. The dashboard recomputes
 * each row's category when it reads either way, and only trusts a stored
 * category set by hand or by a payee rule.
 *
 * Depends on headerIndexMap() and ensureColumn() from Reconcile.gs
 * (apps-script/Reconciliations.gs).
 *
 * ── INSTALL ─────────────────────────────────────────────────────────────
 * Paste this as a NEW script file named `Categories` (Deployer only
 * replaces files that already exist), then paste the updated
 * Reconciliations.gs (menu item). Reload the sheet and run
 * Finances > Setup > Categories… once.
 *
 * ── BACKFILL (C4) ───────────────────────────────────────────────────────
 * Finances > Setup > Categorise Transactions… runs the rules over every
 * row and writes Category / Category Rule. A category set by hand or by a
 * payee rule is kept (the rules already put those first). It previews the
 * changes, then shows coverage: for each billing month, how much of the
 * Variable spending has a category, and the uncategorised payees that
 * cost the most. Give those a default in Payees column F and run it again.
 * The goal is ≥ 90% of a month's Variable rupiah categorised. Safe to
 * rerun any time.
 */

var CATEGORIES_SHEET_NAME = 'Categories';
var CATEGORIES_HEADERS = ['Name', 'Group', 'Colour', 'Order', 'Active', 'Bank Labels'];
var CATEGORY_COLUMN_NAME = 'Category';
var CATEGORY_RULE_COLUMN_NAME = 'Category Rule';
var CATEGORY_UNCATEGORISED = 'Uncategorised';
var CATEGORY_INCOME_GROUP = 'Income';

var CATEGORY_GROUP_COLOURS = {
  'Food & Drink': '#60a5fa',
  'Transport': '#fb923c',
  'Home': '#a3e635',
  'Family & Kids': '#f472b6',
  'Health': '#f87171',
  'Personal': '#a78bfa',
  'Fun & Hobbies': '#2dd4bf',
  'Giving': '#fbbf24',
  'Money': '#94a3b8',
  'Income': '#4ade80'
};

// [name, group, bank labels]. Same list as DEFAULT_CATEGORY_LIST in
// api/_lib/categories.js.
var CATEGORY_DEFAULT_LIST = [
  ['Groceries', 'Food & Drink', ''],
  ['Eating out', 'Food & Drink', 'Makanan dan Minuman'],
  ['Food delivery', 'Food & Drink', ''],
  ['Coffee & snacks', 'Food & Drink', ''],
  ['Ride-hailing', 'Transport', 'Transportasi'],
  ['Public transport', 'Transport', ''],
  ['Fuel, toll & parking', 'Transport', ''],
  ['Vehicle service', 'Transport', ''],
  ['Rent / mortgage', 'Home', ''],
  ['Utilities', 'Home', ''],
  ['Internet & phone', 'Home', ''],
  ['Household supplies', 'Home', 'Belanja dan Servis'],
  ['Help & repairs', 'Home', ''],
  ['School fees', 'Family & Kids', ''],
  ['Kids', 'Family & Kids', ''],
  ['Family support', 'Family & Kids', ''],
  ['Doctor & medicine', 'Health', ''],
  ['Insurance', 'Health', ''],
  ['Clothing', 'Personal', ''],
  ['Electronics', 'Personal', ''],
  ['Personal care', 'Personal', ''],
  ['Subscriptions', 'Fun & Hobbies', ''],
  ['Golf', 'Fun & Hobbies', ''],
  ['Games', 'Fun & Hobbies', ''],
  ['Outings', 'Fun & Hobbies', ''],
  ['Zakat & sedekah', 'Giving', ''],
  ['Gifts & kondangan', 'Giving', ''],
  ['Bank fees & stamp duty', 'Money', ''],
  ['Loan fees', 'Money', ''],
  ['Card interest', 'Money', ''],
  ['Salary', 'Income', ''],
  ['THR', 'Income', ''],
  ['Other income', 'Income', '']
];

// ── Rules (pure) ────────────────────────────────────────────────────────

function categories_key_(s) {
  return String(s === null || s === undefined ? '' : s).trim().replace(/\s+/g, ' ').toLowerCase();
}

function categories_tidy_(s) {
  return String(s === null || s === undefined ? '' : s).trim().replace(/\s+/g, ' ');
}

function categories_splitLabels_(v) {
  return String(v === null || v === undefined ? '' : v).split(/[;\n]/)
    .map(function (s) { return categories_tidy_(s); })
    .filter(function (s) { return s; });
}

function categories_isActive_(v) {
  if (v === '' || v === undefined || v === null) return true;
  if (v === false) return false;
  return String(v).trim().toUpperCase() !== 'FALSE';
}

/** Categories tab rows (A2:F values) -> [{name, group, colour, order, active, bankLabels}]. */
function categories_parseRows_(values) {
  var seen = {};
  var out = [];
  (values || []).forEach(function (row) {
    var name = categories_tidy_(row[0]);
    var key = categories_key_(name);
    if (!name || key === categories_key_(CATEGORY_UNCATEGORISED) || seen[key]) return;
    seen[key] = true;
    var group = categories_tidy_(row[1]) || 'Other';
    var orderNum = Number(row[3]);
    out.push({
      name: name,
      group: group,
      colour: categories_tidy_(row[2]) || CATEGORY_GROUP_COLOURS[group] || '',
      order: row[3] !== '' && row[3] !== undefined && isFinite(orderNum) ? orderNum : null,
      active: categories_isActive_(row[4]),
      bankLabels: categories_splitLabels_(row[5])
    });
  });
  return out;
}

/** The starter list as parsed rows. */
function categories_defaults_() {
  return categories_parseRows_(CATEGORY_DEFAULT_LIST.map(function (r, i) {
    return [r[0], r[1], '', (i + 1) * 10, true, r[2]];
  }));
}

/**
 * categories: parsed rows. payeeRows: [{name, category}].
 * billCategories: {'IB-3': 'Utilities'} (optional).
 * Mirrors buildCategoryContext() in api/_lib/categories.js.
 */
function categories_buildContext_(categories, payeeRows, billCategories) {
  var byKey = {};
  var labels = [];
  (categories || []).forEach(function (c) {
    byKey[categories_key_(c.name)] = c;
    (c.bankLabels || []).forEach(function (l) {
      var k = categories_key_(l);
      if (k) labels.push({ key: k, name: c.name });
    });
  });
  labels.sort(function (a, b) { return b.key.length - a.key.length; });
  var payees = {};
  (payeeRows || []).forEach(function (p) {
    var k = categories_key_(p.name);
    if (k && p.category) payees[k] = p.category;
  });
  var bills = {};
  Object.keys(billCategories || {}).forEach(function (id) {
    var v = billCategories[id];
    if (v) bills[String(id).trim().toUpperCase()] = v;
  });
  return { byKey: byKey, labels: labels, payees: payees, bills: bills };
}

function categories_resolve_(ctx, name, type) {
  var c = ctx.byKey[categories_key_(name)];
  if (!c) return null;
  return (type === 'Income') === (c.group === CATEGORY_INCOME_GROUP) ? c : null;
}

function categories_notesHaveLabel_(notesKey, labelKey) {
  var re = new RegExp('(^|[^a-z0-9])' + labelKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|[^a-z0-9])');
  return re.test(notesKey);
}

function categories_result_(c, rule) {
  return { category: c ? c.name : null, group: c ? c.group : null, rule: rule };
}

/**
 * f: {type, isTransfer, billId, notes, payee, storedCategory, storedCategoryRule}
 * Returns {category, group, rule}. Pure — mirrors classifyCategory() in
 * api/_lib/categories.js.
 */
function categories_classify_(f, ctx) {
  f = f || {};
  var c = ctx || categories_buildContext_(categories_defaults_(), [], {});
  var type = f.type === 'Income' ? 'Income' : 'Expense';
  var hit;

  if (f.isTransfer) return categories_result_(null, 'transfer');

  var stored = f.storedCategory;
  var storedRule = categories_key_(f.storedCategoryRule);
  if (stored && categories_key_(stored) !== categories_key_(CATEGORY_UNCATEGORISED)) {
    hit = categories_resolve_(c, stored, type);
    if (hit && (storedRule === '' || storedRule === 'manual')) return categories_result_(hit, 'manual');
  }

  var billId = String(f.billId === null || f.billId === undefined ? '' : f.billId).trim().toUpperCase();
  if (/^IB-\d+$/.test(billId) && c.bills[billId]) {
    hit = categories_resolve_(c, c.bills[billId], type);
    if (hit) return categories_result_(hit, 'bill');
  }

  if (stored && /^rule\b/.test(storedRule)) {
    hit = categories_resolve_(c, stored, type);
    if (hit) return categories_result_(hit, categories_tidy_(f.storedCategoryRule));
  }

  var payeeCat = c.payees[categories_key_(f.payee)];
  if (payeeCat) {
    hit = categories_resolve_(c, payeeCat, type);
    if (hit) return categories_result_(hit, 'payee');
  }

  var notesKey = categories_key_(f.notes);
  if (notesKey) {
    for (var i = 0; i < c.labels.length; i++) {
      if (categories_notesHaveLabel_(notesKey, c.labels[i].key)) {
        hit = categories_resolve_(c, c.labels[i].name, type);
        if (hit) return categories_result_(hit, 'bank-label');
      }
    }
  }

  if (type === 'Income') return categories_result_(null, 'default');
  return { category: CATEGORY_UNCATEGORISED, group: null, rule: 'default' };
}

// ── Loading from the sheet ──────────────────────────────────────────────

var categoriesContextCache_ = null;

/**
 * The rules' context from the Categories, Payees and installmentsbills
 * tabs. Cached per run; resetCategoriesCache_() at the start of each run.
 */
function categories_context_(ss) {
  if (categoriesContextCache_) return categoriesContextCache_;
  ss = ss || SpreadsheetApp.getActiveSpreadsheet();
  var list = null;
  var tab = ss.getSheetByName(CATEGORIES_SHEET_NAME);
  if (tab && tab.getLastRow() >= 2) {
    list = categories_parseRows_(tab.getRange(2, 1, tab.getLastRow() - 1, CATEGORIES_HEADERS.length).getValues());
  }
  if (!list || !list.length) list = categories_defaults_();

  var payeeRows = [];
  var payees = ss.getSheetByName('Payees');
  if (payees && payees.getLastRow() >= 2) {
    var values = payees.getRange(1, 1, payees.getLastRow(), payees.getLastColumn()).getValues();
    var headers = values[0].map(function (h) { return String(h || '').trim().toLowerCase(); });
    var nameCol = headers.indexOf('payee');
    if (nameCol === -1) nameCol = 0;
    var catCol = headers.indexOf('category');
    if (catCol !== -1) {
      for (var i = 1; i < values.length; i++) {
        var name = String(values[i][nameCol] || '').trim();
        var cat = categories_tidy_(values[i][catCol]);
        if (name && cat) payeeRows.push({ name: name, category: cat });
      }
    }
  }
  categoriesContextCache_ = categories_buildContext_(list, payeeRows, categories_billCategories_(ss));
  return categoriesContextCache_;
}

/** {'IB-3': 'Utilities', …} from installmentsbills' ID and Category columns. */
function categories_billCategories_(ss) {
  var out = {};
  var bills = ss.getSheetByName('installmentsbills');
  if (!bills || bills.getLastRow() < 2) return out;
  var values = bills.getRange(1, 1, bills.getLastRow(), bills.getLastColumn()).getValues();
  var headers = values[0].map(function (h) { return String(h || '').trim().toLowerCase(); });
  var idCol = headers.indexOf('id');
  var catCol = headers.indexOf('category');
  if (idCol === -1 || catCol === -1) return out;
  for (var i = 1; i < values.length; i++) {
    var id = String(values[i][idCol] || '').trim().toUpperCase();
    var cat = categories_tidy_(values[i][catCol]);
    if (id && cat) out[id] = cat;
  }
  return out;
}

/**
 * The Category / Category Rule cells to write for a new row, from the
 * rules above. f is what categories_classify_ takes. A transfer, or an
 * Income row nothing matched, gets blank cells.
 */
function categories_cellsFor_(f, ss) {
  var c = categories_classify_(f, categories_context_(ss));
  return { category: c.category || '', rule: c.category ? c.rule : (c.rule === 'transfer' ? 'transfer' : '') };
}

/**
 * Dropdown of the Categories tab's names, for columns where you type a
 * category. Warns on other text rather than rejecting it. null when the
 * Categories tab doesn't exist yet.
 */
function categories_validation_(ss) {
  var tab = ss.getSheetByName(CATEGORIES_SHEET_NAME);
  if (!tab) return null;
  return SpreadsheetApp.newDataValidation()
    .requireValueInRange(tab.getRange('A2:A'), true)
    .setAllowInvalid(true)
    .setHelpText('A category from the Categories tab.')
    .build();
}

/** Puts categories_validation_() on rows 2+ of a 0-based column. */
function categories_applyValidation_(sheet, col0, rule) {
  if (!sheet || col0 < 0 || !rule) return;
  sheet.getRange(2, col0 + 1, Math.max(sheet.getMaxRows() - 1, 1), 1).setDataValidation(rule);
}

function resetCategoriesCache_() {
  categoriesContextCache_ = null;
}

/** Adds Category / Category Rule to `transactions` if missing. */
function ensureCategoryColumns_(txnSheet) {
  ensureColumn(txnSheet, CATEGORY_COLUMN_NAME);
  ensureColumn(txnSheet, CATEGORY_RULE_COLUMN_NAME);
}

// ── Setup ───────────────────────────────────────────────────────────────

/** Menu entry point: Finances > Setup > Categories… */
function setupCategories() {
  var ui = SpreadsheetApp.getUi();
  var ss = SpreadsheetApp.getActive();

  var payees = ss.getSheetByName('Payees');
  if (payees) {
    // The dashboard reads Payees by position: Kind in E, Category in F.
    var e1 = String(payees.getRange(1, 5).getValue() || '').trim();
    var f1 = String(payees.getRange(1, 6).getValue() || '').trim();
    if (e1 && e1.toLowerCase() !== 'kind') {
      ui.alert('Set Up Categories',
        'Payees column E is "' + e1 + '", but the dashboard expects "Kind" there and "Category" in F. ' +
          'Move that column, then run this again.', ui.ButtonSet.OK);
      return;
    }
    if (f1 && f1.toLowerCase() !== 'category') {
      ui.alert('Set Up Categories',
        'Payees column F is "' + f1 + '", but the dashboard expects "Category" there. ' +
          'Move that column, then run this again.', ui.ButtonSet.OK);
      return;
    }
  }

  var tab = ss.getSheetByName(CATEGORIES_SHEET_NAME);
  var created = false;
  if (!tab) {
    tab = ss.insertSheet(CATEGORIES_SHEET_NAME);
    tab.getRange(1, 1, 1, CATEGORIES_HEADERS.length).setValues([CATEGORIES_HEADERS]);
    created = true;
  } else {
    var head = tab.getRange(1, 1, 1, CATEGORIES_HEADERS.length).getValues()[0];
    var wrong = [];
    CATEGORIES_HEADERS.forEach(function (h, i) {
      var have = String(head[i] || '').trim();
      if (have && have.toLowerCase() !== h.toLowerCase()) wrong.push(String.fromCharCode(65 + i) + ' is "' + have + '"');
    });
    if (wrong.length) {
      ui.alert('Set Up Categories',
        'The Categories tab\'s columns must be, in order: ' + CATEGORIES_HEADERS.join(', ') + '. ' +
          'Now: ' + wrong.join('; ') + '. Fix the header row, then run this again.', ui.ButtonSet.OK);
      return;
    }
    tab.getRange(1, 1, 1, CATEGORIES_HEADERS.length).setValues([CATEGORIES_HEADERS]);
  }

  var existing = tab.getLastRow() >= 2
    ? categories_parseRows_(tab.getRange(2, 1, tab.getLastRow() - 1, CATEGORIES_HEADERS.length).getValues())
    : [];
  var have = {};
  existing.forEach(function (c) { have[categories_key_(c.name)] = true; });
  var missing = categories_defaults_().filter(function (c) { return !have[categories_key_(c.name)]; });

  if (!created && missing.length) {
    var answer = ui.alert('Set Up Categories',
      missing.length + ' starter categor' + (missing.length === 1 ? 'y is' : 'ies are') + ' not on your tab yet: ' +
        missing.map(function (c) { return c.name; }).join(', ') +
        '.\n\nAdd them at the bottom? (No keeps your list as it is.) Your rows are never changed.',
      ui.ButtonSet.YES_NO_CANCEL);
    if (answer === ui.Button.CANCEL || answer === ui.Button.CLOSE) return;
    if (answer === ui.Button.NO) missing = [];
  }

  if (missing.length) {
    var start = Math.max(tab.getLastRow(), 1) + 1;
    tab.getRange(start, 1, missing.length, CATEGORIES_HEADERS.length).setValues(missing.map(function (c) {
      return [c.name, c.group, CATEGORY_GROUP_COLOURS[c.group] || '', c.order, true, c.bankLabels.join('; ')];
    }));
  }

  var rows = Math.max(tab.getMaxRows() - 1, 1);
  tab.setFrozenRows(1);
  tab.getRange(1, 1, 1, CATEGORIES_HEADERS.length).setFontWeight('bold');
  tab.getRange(2, 5, rows, 1).insertCheckboxes();
  tab.getRange(2, 4, rows, 1).setNumberFormat('0');
  tab.getRange(1, 6).setNote('Category names the bank apps print in Notes, e.g. "Makanan dan Minuman". ' +
    'Separate several with ";". A row whose Notes contain one gets this category when nothing more specific applies.');

  var txn = ss.getSheetByName('transactions');
  if (txn) ensureCategoryColumns_(txn);
  if (payees) {
    if (!String(payees.getRange(1, 5).getValue() || '').trim()) payees.getRange(1, 5).setValue('Kind');
    if (!String(payees.getRange(1, 6).getValue() || '').trim()) payees.getRange(1, 6).setValue('Category');
  }
  var bills = ss.getSheetByName('installmentsbills');
  var billCatCol = bills ? ensureColumn(bills, CATEGORY_COLUMN_NAME) : -1;

  // Dropdowns where you type a category.
  var dropdown = categories_validation_(ss);
  if (payees) categories_applyValidation_(payees, 5, dropdown);
  if (bills) categories_applyValidation_(bills, billCatCol, dropdown);
  var rulesTab = ss.getSheetByName('PayeeRules');
  if (rulesTab) {
    var ruleHeaders = rulesTab.getRange(1, 1, 1, Math.max(rulesTab.getLastColumn(), 1)).getValues()[0]
      .map(function (h) { return String(h || '').trim().toLowerCase(); });
    categories_applyValidation_(rulesTab, ruleHeaders.indexOf('set category'), dropdown);
  }
  resetCategoriesCache_();

  ui.alert('Set Up Categories',
    (created ? 'Created the Categories tab with ' + missing.length + ' starter categories. '
      : (missing.length ? 'Added ' + missing.length + ' categories. ' : 'Your Categories tab is unchanged. ')) +
      'transactions now has Category and Category Rule columns' + (payees ? ', Payees has Category in column F' : '') +
      (bills ? ', and installmentsbills has a Category column' : '') +
      '.\n\nPick a payee\'s default in Payees column F and each bill\'s in installmentsbills, from the dropdown. Check the Bank Labels guesses too.',
    ui.ButtonSet.OK);
  tab.activate();
}

// ── Backfill (C4) ───────────────────────────────────────────────────────

var CATEGORIES_PREVIEW_MAX = 15;
var CATEGORIES_SUMMARY_MONTHS = 6;
var CATEGORIES_TOP_PAYEES = 10;
var CATEGORIES_TOP_PAYEE_MONTHS = 3;
var CATEGORIES_COVERAGE_GOAL = 0.9;

/** Menu entry point: Finances > Setup > Categorise Transactions… */
function categoriseTransactionHistory() {
  var ui = SpreadsheetApp.getUi();
  // Same locks as the Kind backfill: imports append or edit rows under
  // the script lock (email, payee rules) or the document lock (inbox).
  var scriptLock = LockService.getScriptLock();
  var docLock = LockService.getDocumentLock();
  if (!scriptLock.tryLock(30000)) { ui.alert('Another import or script is running. Try again in a moment.'); return; }
  if (!docLock.tryLock(30000)) { scriptLock.releaseLock(); ui.alert('Another import or script is running. Try again in a moment.'); return; }
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(RECONCILE_CONFIG.transactionsSheet);
    if (!sheet) throw new Error('transactions tab not found.');
    if (!ss.getSheetByName(CATEGORIES_SHEET_NAME)) {
      ui.alert('Categorise transactions', 'Run Finances > Setup > Categories… first: it creates the Categories tab.', ui.ButtonSet.OK);
      return;
    }
    ensureCategoryColumns_(sheet);
    resetCategoriesCache_();

    var plan = categories_plan_(sheet, ss);
    var msg = categories_describePlan_(plan);
    if (!plan.changes.length) {
      ui.alert('Categorise transactions', 'Every row already has its category.\n\n' + msg, ui.ButtonSet.OK);
      return;
    }
    if (ui.alert('Categorise transactions', msg + '\n\nWrite these changes?', ui.ButtonSet.YES_NO) !== ui.Button.YES) return;

    // Re-plan from a fresh read: the write is by position and rows could
    // have moved while the dialog was open.
    resetCategoriesCache_();
    var fresh = categories_plan_(sheet, ss);
    if (fresh.rows) {
      sheet.getRange(2, fresh.catCol + 1, fresh.rows, 1).setValues(fresh.catValues);
      sheet.getRange(2, fresh.ruleCol + 1, fresh.rows, 1).setValues(fresh.ruleValues);
    }
    ui.alert('Categorise transactions', 'Updated ' + fresh.changes.length + ' row(s).\n\n' + categories_describeCoverage_(fresh),
      ui.ButtonSet.OK);
  } catch (err) {
    ui.alert('Categorise transactions failed', String(err && err.message || err), ui.ButtonSet.OK);
  } finally {
    docLock.releaseLock();
    scriptLock.releaseLock();
  }
}

/**
 * Reads `transactions` and works out every row's Category / Category
 * Rule. Returns the new column values (blank rows keep theirs), the
 * changes, counts by rule, and coverage: per billing month the Variable
 * spending in total and with a category, and uncategorised spending by
 * payee over the last few months.
 */
function categories_plan_(sheet, ss) {
  var col = headerIndexMap(sheet);
  var payeeHeader = payeeHeaderName(col);
  var catCol = col[CATEGORY_COLUMN_NAME];
  var ruleCol = col[CATEGORY_RULE_COLUMN_NAME];
  var lastRow = sheet.getLastRow();
  var plan = {
    catCol: catCol, ruleCol: ruleCol, rows: Math.max(lastRow - 1, 0),
    catValues: [], ruleValues: [], changes: [], counts: {}, byMonth: {}, uncatByPayee: {}
  };
  if (lastRow < 2) return plan;
  var ctx = categories_context_(ss);
  var payeeKinds = typeof kinds_payeeKinds_ === 'function' ? kinds_payeeKinds_(ss) : {};
  var hasKindFn = typeof kinds_classify_ === 'function';
  var values = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
  function get(r, h) { return h && h in col ? r[col[h]] : ''; }
  function truthy(v) { return v === true || /^(true|yes|y|1)$/i.test(String(v || '').trim()); }

  var monthKeys = [];
  values.forEach(function (r, i) {
    var storedCat = r[catCol];
    var storedRule = r[ruleCol];
    var payee = payeeHeader ? String(r[col[payeeHeader]] || '').trim() : '';
    var amount = Number(get(r, 'Amount')) || 0;
    if (!payee && !amount) {
      plan.catValues.push([storedCat]);
      plan.ruleValues.push([storedRule]);
      return;
    }
    var type = String(get(r, 'Income/Expense')).trim() === 'Income' ? 'Income' : 'Expense';
    var isTransfer = truthy(get(r, 'Transfer'));
    var f = {
      type: type, isTransfer: isTransfer, billId: get(r, BILL_ID_COLUMN_NAME), notes: get(r, 'Notes'),
      payee: payee, storedCategory: storedCat, storedCategoryRule: storedRule
    };
    var res = categories_classify_(f, ctx);
    var cat = res.category || '';
    var rule = res.category ? res.rule : (res.rule === 'transfer' ? 'transfer' : '');
    plan.catValues.push([cat]);
    plan.ruleValues.push([rule]);
    var ruleKey = /^rule\b/.test(rule) ? 'payee rule' : (rule || 'none');
    plan.counts[ruleKey] = (plan.counts[ruleKey] || 0) + 1;
    if (String(storedCat || '') !== cat || String(storedRule || '') !== rule) {
      plan.changes.push({ row: i + 2, payee: payee, from: String(storedCat || '') || '(blank)', to: cat || '(blank)', rule: rule || '—' });
    }

    // Coverage counts Variable spending only: what the categories are for.
    if (type !== 'Expense' || isTransfer) return;
    var kind = hasKindFn ? kinds_classify_({
      type: type, isTransfer: isTransfer, billId: f.billId, notes: f.notes, payee: payee,
      storedKind: get(r, 'Kind'), storedRule: get(r, 'Kind Rule')
    }, payeeKinds).kind : 'Variable';
    if (kind !== 'Variable') return;
    var month = get(r, 'Month');
    if (!(month && typeof month.getFullYear === 'function' && !isNaN(month.getTime()))) return;
    var key = month.getFullYear() + '-' + ('0' + (month.getMonth() + 1)).slice(-2);
    var m = plan.byMonth[key];
    if (!m) { m = plan.byMonth[key] = { total: 0, done: 0 }; monthKeys.push(key); }
    var spend = Math.abs(amount);
    m.total += spend;
    if (cat && cat !== CATEGORY_UNCATEGORISED) m.done += spend;
    else {
      var p = plan.uncatByPayee[key] || (plan.uncatByPayee[key] = {});
      var pk = payee || '(no payee)';
      p[pk] = (p[pk] || 0) + spend;
    }
  });
  return plan;
}

function categories_rp_(n) {
  return 'Rp ' + Math.round(n).toLocaleString('id-ID');
}

/** Coverage lines: per month % categorised, and the biggest gaps by payee. */
function categories_describeCoverage_(plan) {
  var months = Object.keys(plan.byMonth).sort().reverse();
  if (!months.length) return 'No Variable spending with a billing month to measure yet.';
  var lines = months.slice(0, CATEGORIES_SUMMARY_MONTHS).map(function (k) {
    var m = plan.byMonth[k];
    var pct = m.total ? m.done / m.total : 1;
    return k + '  ' + Math.floor(pct * 100) + '% of ' + categories_rp_(m.total) +
      (pct >= CATEGORIES_COVERAGE_GOAL ? '  ✓' : '');
  });
  var out = ['Variable spending with a category, by billing month (goal ' +
    Math.round(CATEGORIES_COVERAGE_GOAL * 100) + '%):\n' + lines.join('\n')];

  var byPayee = {};
  months.slice(0, CATEGORIES_TOP_PAYEE_MONTHS).forEach(function (k) {
    var p = plan.uncatByPayee[k] || {};
    Object.keys(p).forEach(function (name) { byPayee[name] = (byPayee[name] || 0) + p[name]; });
  });
  var top = Object.keys(byPayee).sort(function (a, b) { return byPayee[b] - byPayee[a]; }).slice(0, CATEGORIES_TOP_PAYEES);
  if (top.length) {
    out.push('Biggest uncategorised payees, last ' + CATEGORIES_TOP_PAYEE_MONTHS + ' months. ' +
      'Give them a category in Payees column F (or on the dashboard\'s Payees page), then run this again:\n' +
      top.map(function (name) { return name + '  ' + categories_rp_(byPayee[name]); }).join('\n'));
  }
  return out.join('\n\n');
}

function categories_describePlan_(plan) {
  var parts = [];
  var order = ['manual', 'bill', 'payee rule', 'payee', 'bank-label', 'default', 'transfer', 'none'];
  var counts = order.filter(function (k) { return plan.counts[k]; }).map(function (k) { return k + ' ' + plan.counts[k]; });
  if (counts.length) parts.push('Rows by how their category was found: ' + counts.join(', ') + '.');
  if (plan.changes.length) {
    var lines = plan.changes.slice(0, CATEGORIES_PREVIEW_MAX).map(function (c) {
      return 'Row ' + c.row + ' ' + c.payee + ': ' + c.from + ' → ' + c.to + ' (' + c.rule + ')';
    });
    if (plan.changes.length > CATEGORIES_PREVIEW_MAX) lines.push('…and ' + (plan.changes.length - CATEGORIES_PREVIEW_MAX) + ' more.');
    parts.push(plan.changes.length + ' row(s) will change:\n' + lines.join('\n'));
  }
  parts.push(categories_describeCoverage_(plan));
  return parts.join('\n\n');
}
