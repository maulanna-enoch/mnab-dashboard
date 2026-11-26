// Home page endpoint.
//
// The Diary-based monthly Cash Flow (?month=YYYY-MM and ?action=months) was
// removed when the Diary tab was retired (Debt Exit plan); Home now runs on
// the weekly budget and the debt projection below.
//
// GET ?action=settings        -> the Settings tab, typed and defaulted
//                                (see api/_lib/settings.js). Lives here
//                                because the 12-function cap is full.
//
// GET ?action=week            -> the weekly budget (Debt Exit WS4): this
//                                week's Variable spending, allowance +
//                                rollover, what's left, a per-day hint and
//                                the last 12 weeks. Rules in api/_lib/week.js.
//     &date=YYYY-MM-DD        -> as of that day instead of today (Jakarta)
//     &weeks=N                -> N weeks of history (default 12, max 104)
//     &transactions=0         -> leave out this week's transaction list
//   The response also has `where`: this week's spending by category and top
//   payees (the Home "Where it went" card), same as ?action=where below.
//
// GET ?action=where           -> Where it went (Debt Exit WS8): Variable
//                                spending by category and payee for a week
//                                or calendar month, compared with the one
//                                before. Rules in api/_lib/where.js.
//     &period=week|month      -> default week
//     &offset=N               -> 0 = current (default), -1 = the one before…
//     &category=NAME          -> also that category's last 12 periods,
//                                payees and transactions
//     &date=YYYY-MM-DD        -> as of that day instead of today (Jakarta)
//
// GET ?action=debt            -> the actual hole and debt projection (Debt
//                                Exit WS6): the hole from the Steals log, the
//                                Payoff-plan projection month by month, the
//                                debt-free month and estimated date, the same
//                                at your recent pace, and how far last week
//                                moved it. Rules in api/_lib/debt.js.
//     &date=YYYY-MM-DD        -> as of that day instead of today (Jakarta)
//     &months=N               -> months projected (default 60, max 240)
//     &pace=N                 -> weeks averaged for "at your pace" (default 4)
//     &rows=0                 -> leave out the month-by-month table
const {
  fetchSettings,
  fetchClassifiedTransactionRows,
  fetchStealsRows,
  fetchInstallmentRows,
  fetchAccountRows,
} = require('./_lib/sheets');
const { SETTINGS_SCHEMA } = require('./_lib/settings');
const { computeWeek, jakartaToday, isoFromDay } = require('./_lib/week');
const { projectDebt } = require('./_lib/debt');
const { computeWhere } = require('./_lib/where');
const { KIND_CARD_BILL } = require('./_lib/bills');

async function actionSettings(res) {
  const { values, warnings, tabFound } = await fetchSettings();
  const schema = {};
  Object.keys(SETTINGS_SCHEMA).forEach((k) => {
    schema[k] = { type: SETTINGS_SCHEMA[k].type, default: SETTINGS_SCHEMA[k].default, description: SETTINGS_SCHEMA[k].description };
  });
  // Short cache: an edit in the sheet should show up within a minute.
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate');
  res.status(200).json({ settings: values, warnings, tabFound, schema, updatedAt: new Date().toISOString() });
}

async function actionWeek(req, res) {
  const q = req.query || {};
  if (q.date && !/^\d{4}-\d{2}-\d{2}$/.test(String(q.date))) {
    res.status(400).json({ error: 'Invalid "date" -- expected YYYY-MM-DD' });
    return;
  }
  const [{ values, warnings: settingsWarnings }, rows] = await Promise.all([
    fetchSettings(),
    fetchClassifiedTransactionRows(),
  ]);
  let result;
  let where;
  try {
    result = computeWeek(rows, values, {
      asOf: q.date ? String(q.date) : undefined,
      historyWeeks: q.weeks !== undefined ? parseInt(q.weeks, 10) : undefined,
      includeTransactions: q.transactions !== '0',
    });
    const w = computeWhere(rows, values, { period: 'week', asOf: q.date ? String(q.date) : undefined, topPayees: 3 });
    where = { start: w.start, end: w.end, total: w.total, count: w.count, compare: w.compare, categories: w.categories, payees: w.payees };
  } catch (err) {
    res.status(400).json({ error: err.message });
    return;
  }
  // Same freshness as transactions-list: a new swipe should show at once.
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({
    ...result,
    where,
    settingsWarnings,
    updatedAt: new Date().toISOString(),
  });
}

async function actionWhere(req, res) {
  const q = req.query || {};
  if (q.date && !/^\d{4}-\d{2}-\d{2}$/.test(String(q.date))) {
    res.status(400).json({ error: 'Invalid "date" -- expected YYYY-MM-DD' });
    return;
  }
  if (q.period && !['week', 'month'].includes(String(q.period))) {
    res.status(400).json({ error: 'Invalid "period" -- expected week or month' });
    return;
  }
  const [{ values, warnings: settingsWarnings }, rows] = await Promise.all([
    fetchSettings(),
    fetchClassifiedTransactionRows(),
  ]);
  let result;
  try {
    result = computeWhere(rows, values, {
      period: q.period ? String(q.period) : 'week',
      offset: q.offset !== undefined ? Number(q.offset) : 0,
      asOf: q.date ? String(q.date) : undefined,
      category: q.category ? String(q.category) : undefined,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
    return;
  }
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({ ...result, settingsWarnings, updatedAt: new Date().toISOString() });
}

async function actionDebt(req, res) {
  const q = req.query || {};
  if (q.date && !/^\d{4}-\d{2}-\d{2}$/.test(String(q.date))) {
    res.status(400).json({ error: 'Invalid "date" -- expected YYYY-MM-DD' });
    return;
  }
  const [{ values, warnings: settingsWarnings }, stealsRows, billRows, accounts, txRows] = await Promise.all([
    fetchSettings(),
    fetchStealsRows(),
    fetchInstallmentRows(),
    fetchAccountRows(),
    fetchClassifiedTransactionRows(),
  ]);
  const today = q.date ? String(q.date) : isoFromDay(jakartaToday());

  // Paid by card: a Card bill, or anything whose SOF is a credit card
  // account (same "type contains credit" test as everywhere else).
  const creditNames = new Set(accounts
    .filter((a) => String(a.type || '').toLowerCase().includes('credit'))
    .map((a) => String(a.name).trim().toLowerCase()));
  const isCardRow = (r) => r.kind === KIND_CARD_BILL || creditNames.has(String(r.sof || '').trim().toLowerCase());

  let week = null;
  try {
    week = computeWeek(txRows, values, { asOf: today, includeTransactions: false });
  } catch (err) {
    res.status(400).json({ error: err.message });
    return;
  }

  const result = projectDebt(
    { settings: values, stealsRows, billRows, isCardRow, week, today },
    {
      months: q.months !== undefined ? parseInt(q.months, 10) : undefined,
      paceWeeks: q.pace !== undefined ? parseInt(q.pace, 10) : undefined,
      includeMonths: q.rows !== '0',
    },
  );
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({ ...result, settingsWarnings, updatedAt: new Date().toISOString() });
}

module.exports = async (req, res) => {
  try {
    if (req.query && req.query.action === 'settings') return await actionSettings(res);
    if (req.query && req.query.action === 'week') return await actionWeek(req, res);
    if (req.query && req.query.action === 'debt') return await actionDebt(req, res);
    if (req.query && req.query.action === 'where') return await actionWhere(req, res);

    res.status(400).json({ error: 'Unknown or missing action. Use ?action=week, ?action=where, ?action=debt or ?action=settings.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};
