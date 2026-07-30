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

    const paidItems = monthRows
      .filter((r) => r.type === 'Expense' && r.isPaid)
      .map((r) => ({ name: r.name, amount: r.amount, category: r.category }));
    const budgetedItems = monthRows
      .filter((r) => r.type === 'Expense' && !r.isPaid)
      .map((r) => ({ name: r.name, amount: r.amount, category: r.category }));

    const paid = paidItems.reduce((sum, i) => sum + i.amount, 0);
    const budgeted = budgetedItems.reduce((sum, i) => sum + i.amount, 0);
    const outflow = paid + budgeted;
    const leftToSpend = income - outflow;

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate');
    res.status(200).json({
      month,
      income,
      incomeItems,
      paid,
      budgeted,
      outflow,
      leftToSpend,
      paidItems,
      budgetedItems,
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};
