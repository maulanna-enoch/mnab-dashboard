// Categories for `transactions` (Category system, C1).
//
// Kind (api/_lib/kinds.js) says whether a row is a commitment: Fixed,
// Variable, Transfer or Income. Category says what the money was for:
// Eating out, Ride-hailing, School fees… The two are independent -- a
// Vidio subscription is Fixed + Subscriptions, a GoFood order is
// Variable + Food delivery. "Where it went" (WS8) filters to Variable and
// groups by Category; bills get categories too.
//
// Two levels: every category belongs to one Group (Food & Drink,
// Transport…). A row has one category (no split transactions). The list
// lives on the `Categories` tab; until that tab exists the built-in
// DEFAULT_CATEGORIES below are used, and apps-script/Categories.gs
// (Finances > Setup > Categories…) seeds the tab from the same list.
//
// The `Income` group is special: its categories are only for Income rows,
// and every other group's only for Expense rows.
//
// Rules, first match wins:
//   1. Transfer flag             -> none        (rule "transfer")
//   2. Category set by hand      -> as set      (rule "manual")
//   3. Linked to a bill          -> the bill's  (rule "bill")
//      (Source ID = IB-n, and that installmentsbills row has a Category)
//   4. Set by a payee rule       -> as set      (rule "rule …", e.g. "rule #50")
//      (PayeeRules' Set Category, applied by EmailImport.gs at import)
//   5. Payee has a Category on
//      the Payees tab (column F) -> that one    (rule "payee")
//   6. Notes carry a bank label
//      listed on the Categories
//      tab (Bank Labels)         -> that one    (rule "bank-label")
//   7. Otherwise                 -> Expense: Uncategorised, Income: none
//                                               (rule "default")
//
// A stored category only counts (rules 2 and 4) when the name is on the
// list and fits the row's type. Anything else falls through to the next
// rule; the sheet cell itself is left alone.
//
// Columns on `transactions` (self-provisioned, read by header name):
//   Category       the result above (blank for transfers)
//   Category Rule  which rule produced it. "manual" marks a hand-set
//                  category; a Category with a BLANK Category Rule (typed
//                  straight into the sheet) also counts as manual. A rule
//                  starting "rule" is a payee rule's choice and is kept as
//                  stored, since the dashboard can't rerun payee rules
//                  (they match the raw bank text, kept in Apps Script).
//
// Like Kind, readers recompute the category on every read and only trust
// the stored value for rules 2 and 4.
//
// The same rules live in apps-script/Categories.gs. Change both together.

const CATEGORY_COLUMN = 'Category';
const CATEGORY_RULE_COLUMN = 'Category Rule';
const UNCATEGORISED = 'Uncategorised';
const INCOME_GROUP = 'Income';

// Columns of the `Categories` tab, A:F.
const CATEGORIES_RANGE = 'Categories!A2:F';
const CATEGORIES_HEADERS = ['Name', 'Group', 'Colour', 'Order', 'Active', 'Bank Labels'];

// Group colours, chosen to read on the dashboard's dark background.
const GROUP_COLOURS = {
  'Food & Drink': '#60a5fa',
  Transport: '#fb923c',
  Home: '#a3e635',
  'Family & Kids': '#f472b6',
  Health: '#f87171',
  Personal: '#a78bfa',
  'Fun & Hobbies': '#2dd4bf',
  Giving: '#fbbf24',
  Money: '#94a3b8',
  Income: '#4ade80',
};

// [name, group, bank labels]. The bank labels are the categories the
// banks' own apps print in Notes (Livin'): a first guess, edit them on the
// tab.
const DEFAULT_CATEGORY_LIST = [
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
  ['Other income', 'Income', ''],
];

const DEFAULT_CATEGORIES = DEFAULT_CATEGORY_LIST.map(([name, group, bankLabels], i) => ({
  name,
  group,
  colour: GROUP_COLOURS[group] || '',
  order: (i + 1) * 10,
  active: true,
  bankLabels: splitBankLabels(bankLabels),
}));

// ── Helpers ────────────────────────────────────────────────────────────────

function normKey(s) {
  return String(s == null ? '' : s).trim().replace(/\s+/g, ' ').toLowerCase();
}

// Bank Labels cell: several labels separated by ";" or new lines.
function splitBankLabels(v) {
  return String(v == null ? '' : v)
    .split(/[;\n]/)
    .map((s) => s.trim().replace(/\s+/g, ' '))
    .filter(Boolean);
}

function isActiveCell(v) {
  if (v === '' || v === undefined || v === null) return true; // blank = active
  if (v === false) return false;
  return String(v).trim().toUpperCase() !== 'FALSE';
}

// Rows of the Categories tab (A2:F values) -> category objects. Blank names
// and the reserved "Uncategorised" are skipped; a repeated name keeps its
// first row.
function parseCategoryRows(values) {
  const seen = new Set();
  const out = [];
  (values || []).forEach((row) => {
    const name = String(row[0] == null ? '' : row[0]).trim().replace(/\s+/g, ' ');
    const key = normKey(name);
    if (!name || key === normKey(UNCATEGORISED) || seen.has(key)) return;
    seen.add(key);
    const group = String(row[1] == null ? '' : row[1]).trim().replace(/\s+/g, ' ') || 'Other';
    const orderNum = Number(row[3]);
    out.push({
      name,
      group,
      colour: String(row[2] == null ? '' : row[2]).trim() || GROUP_COLOURS[group] || '',
      order: row[3] !== '' && row[3] !== undefined && Number.isFinite(orderNum) ? orderNum : null,
      active: isActiveCell(row[4]),
      bankLabels: splitBankLabels(row[5]),
    });
  });
  return out;
}

// Everything classifyCategory needs, built once per read.
// categories: parseCategoryRows() output (or DEFAULT_CATEGORIES).
// payeeRows: fetchPayeeRows() output ({ name, category }).
// billCategories: { 'IB-3': 'Utilities', … } (optional).
function buildCategoryContext(categories, payeeRows, billCategories) {
  const byKey = {};
  const labels = [];
  (categories || []).forEach((c) => {
    byKey[normKey(c.name)] = c;
    (c.bankLabels || []).forEach((l) => {
      const k = normKey(l);
      if (k) labels.push({ key: k, name: c.name });
    });
  });
  // Longest label first, so "Belanja dan Servis Online" beats "Belanja".
  labels.sort((a, b) => b.key.length - a.key.length);
  const payees = {};
  (payeeRows || []).forEach((p) => {
    const k = normKey(p.name);
    if (k && p.category) payees[k] = p.category;
  });
  const bills = {};
  Object.keys(billCategories || {}).forEach((id) => {
    const v = billCategories[id];
    if (v) bills[String(id).trim().toUpperCase()] = v;
  });
  return { byKey, labels, payees, bills };
}

// The list entry for `name` if it exists and fits the row's type, else null.
function resolveCategory(ctx, name, type) {
  const c = ctx.byKey[normKey(name)];
  if (!c) return null;
  const isIncomeCat = c.group === INCOME_GROUP;
  return (type === 'Income') === isIncomeCat ? c : null;
}

function isManualRule(storedRule) {
  const r = normKey(storedRule);
  return r === '' || r === 'manual';
}

function isPayeeRuleRule(storedRule) {
  return /^rule\b/.test(normKey(storedRule));
}

// Whole-phrase match of a bank label inside Notes.
function notesHaveLabel(notesKey, labelKey) {
  const re = new RegExp('(^|[^a-z0-9])' + labelKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|[^a-z0-9])');
  return re.test(notesKey);
}

function result(c, rule) {
  return { category: c ? c.name : null, group: c ? c.group : null, rule };
}

// fields: { type, isTransfer, billId, notes, payee, storedCategory,
//           storedCategoryRule }
// ctx: buildCategoryContext() output.
// Returns { category, group, rule }. category/group are null for transfers
// and for Income rows no rule matched; an Expense row no rule matched gets
// "Uncategorised" (group null).
function classifyCategory(fields, ctx) {
  const f = fields || {};
  const c = ctx || buildCategoryContext(DEFAULT_CATEGORIES, [], {});
  const type = f.type === 'Income' ? 'Income' : 'Expense';

  if (f.isTransfer) return result(null, 'transfer');

  const stored = f.storedCategory;
  if (stored && normKey(stored) !== normKey(UNCATEGORISED)) {
    const hit = resolveCategory(c, stored, type);
    if (hit && isManualRule(f.storedCategoryRule)) return result(hit, 'manual');
  }

  const billId = String(f.billId == null ? '' : f.billId).trim().toUpperCase();
  if (/^IB-\d+$/.test(billId) && c.bills[billId]) {
    const hit = resolveCategory(c, c.bills[billId], type);
    if (hit) return result(hit, 'bill');
  }

  if (stored && isPayeeRuleRule(f.storedCategoryRule)) {
    const hit = resolveCategory(c, stored, type);
    if (hit) return result(hit, String(f.storedCategoryRule).trim().replace(/\s+/g, ' '));
  }

  const payeeCat = c.payees[normKey(f.payee)];
  if (payeeCat) {
    const hit = resolveCategory(c, payeeCat, type);
    if (hit) return result(hit, 'payee');
  }

  const notesKey = normKey(f.notes);
  if (notesKey) {
    for (let i = 0; i < c.labels.length; i++) {
      if (notesHaveLabel(notesKey, c.labels[i].key)) {
        const hit = resolveCategory(c, c.labels[i].name, type);
        if (hit) return result(hit, 'bank-label');
      }
    }
  }

  if (type === 'Income') return result(null, 'default');
  return { category: UNCATEGORISED, group: null, rule: 'default' };
}

// The Category to store when a row is saved through the dashboard (C3).
// request may carry:
//   categoryManual true + category -> the person picked one
//   categoryManual false           -> reset to automatic
//   neither                        -> keep whatever the row had
// existing: { storedCategory, storedCategoryRule } of the row (add: none).
function categoryForSave(fields, request, existing, ctx) {
  const req = request || {};
  const ex = existing || {};
  let storedCategory = ex.storedCategory || null;
  let storedCategoryRule = ex.storedCategoryRule || null;
  if (req.categoryManual === true && req.category) {
    storedCategory = String(req.category).trim();
    storedCategoryRule = 'manual';
  } else if (req.categoryManual === false) {
    storedCategory = null;
    storedCategoryRule = null;
  }
  return classifyCategory({ ...fields, storedCategory, storedCategoryRule }, ctx);
}

// The list for pickers, by Order (blank Order last, ties in sheet order).
// Inactive categories stay in the list with active false: pickers hide
// them, but rows already using one still show its name and colour.
function sortCategories(categories) {
  return (categories || [])
    .map((c, i) => ({ c, i }))
    .sort((a, b) => {
      const ao = a.c.order == null ? Infinity : a.c.order;
      const bo = b.c.order == null ? Infinity : b.c.order;
      return ao - bo || a.i - b.i;
    })
    .map((x) => x.c);
}

module.exports = {
  CATEGORY_COLUMN,
  CATEGORY_RULE_COLUMN,
  CATEGORIES_RANGE,
  CATEGORIES_HEADERS,
  UNCATEGORISED,
  INCOME_GROUP,
  GROUP_COLOURS,
  DEFAULT_CATEGORY_LIST,
  DEFAULT_CATEGORIES,
  splitBankLabels,
  parseCategoryRows,
  buildCategoryContext,
  classifyCategory,
  categoryForSave,
  sortCategories,
};
