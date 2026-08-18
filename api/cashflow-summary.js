const { fetchDiaryRows } = require('./_lib/sheets');

module.exports = async (req, res) => {
  try {
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
