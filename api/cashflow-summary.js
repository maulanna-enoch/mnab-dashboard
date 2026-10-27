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
const { fetchDiaryRows, monthLabel } = require('./_lib/sheets');

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

module.exports = async (req, res) => {
  try {
    if (req.query && req.query.action === 'months') return await actionMonths(res);

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
