// Cash Flow endpoint for the home page.
//
// GET ?month=YYYY-MM          -> that month's income / outflow / left-to-spend.
// GET ?action=months          -> distinct months found in Diary, for the
//                                month dropdown.
//
// action=months used to be its own file, api/cashflow-months.js. It was
// folded in here to free one of Vercel Hobby's 12 Serverless Function
// slots for api/push.js. vercel.json rewrites the old /api/cashflow-months
// URL to ?action=months, so anything still calling it keeps working.
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
const { fetchDiaryRows, fetchSettings, fetchClassifiedTransactionRows, monthLabel } = require('./_lib/sheets');
const { SETTINGS_SCHEMA } = require('./_lib/settings');
const { computeWeek } = require('./_lib/week');

async function actionMonths(res) {
  const rows = await fetchDiaryRows();
  const monthSet = new Set(rows.filter((r) => r.month).map((r) => r.month));
  const months = Array.from(monthSet)
    .sort()
    .reverse() // most recent first
    .map((value) => ({ value, label: monthLabel(value) }));

  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate');
  res.status(200).json({ months, updatedAt: new Date().toISOString() });
}

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
  try {
    result = computeWeek(rows, values, {
      asOf: q.date ? String(q.date) : undefined,
      historyWeeks: q.weeks !== undefined ? parseInt(q.weeks, 10) : undefined,
      includeTransactions: q.transactions !== '0',
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
    return;
  }
  // Same freshness as transactions-list: a new swipe should show at once.
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({
    ...result,
    settingsWarnings,
    updatedAt: new Date().toISOString(),
  });
}

module.exports = async (req, res) => {
  try {
    if (req.query && req.query.action === 'months') return await actionMonths(res);
    if (req.query && req.query.action === 'settings') return await actionSettings(res);
    if (req.query && req.query.action === 'week') return await actionWeek(req, res);

    const month = (req.query && req.query.month) || '';
    if (!month) {
      res.status(400).json({ error: 'Missing "month" query param, e.g. ?month=2026-08' });
      return;
    }

    const rows = await fetchDiaryRows();
    const monthRows = rows.filter((r) => r.month === month);

    const incomeItems = monthRows
      .filter((r) => r.type === 'Income')
      .map((r) => ({ name: r.name, amount: r.amount }));
    const income = incomeItems.reduce((sum, i) => sum + i.amount, 0);

    const expenseRows = monthRows.filter((r) => r.type === 'Expense');
    const paidItems = expenseRows
      .filter((r) => r.isPaid)
      .map((r) => ({ name: r.name, amount: r.amount, category: r.category }));
    const billedItems = expenseRows
      .filter((r) => r.isBilled)
      .map((r) => ({ name: r.name, amount: r.amount, category: r.category }));
    const unbilledItems = expenseRows
      .filter((r) => r.isUnbilled)
      .map((r) => ({ name: r.name, amount: r.amount, category: r.category }));

    const paid = paidItems.reduce((sum, i) => sum + i.amount, 0);
    const billed = billedItems.reduce((sum, i) => sum + i.amount, 0);
    const unbilled = unbilledItems.reduce((sum, i) => sum + i.amount, 0);
    const outflow = paid + billed + unbilled;
    const leftToSpend = income - outflow;

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate');
    res.status(200).json({
      month,
      income,
      incomeItems,
      paid,
      billed,
      unbilled,
      outflow,
      leftToSpend,
      paidItems,
      billedItems,
      unbilledItems,
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};
