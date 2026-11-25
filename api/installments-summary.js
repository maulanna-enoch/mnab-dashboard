const { fetchInstallmentRows } = require('./_lib/sheets');

// GET ?action=registry (WS1) -- every installmentsbills row that has its
// permanent IB-n ID, for the transaction form's "is this a bill?"
// suggestion (see suggestBills in api/_lib/kinds.js). Lives here because
// the 12-function cap is full.
async function actionRegistry(res) {
  const rows = await fetchInstallmentRows();
  const bills = rows
    .filter((r) => r.id)
    .map((r) => ({ id: r.id, name: r.name, sof: r.sof, amount: r.amount, isActive: r.isActive, isBill: r.isBill, dayOfMonth: r.dayOfMonth }));
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate');
  res.status(200).json({ bills, updatedAt: new Date().toISOString() });
}

module.exports = async (req, res) => {
  try {
    if (req.query && req.query.action === 'registry') return await actionRegistry(res);

    const rows = await fetchInstallmentRows();

    let total = 0;
    let activeCount = 0;

    for (const r of rows) {
      if (r.isActive && !r.isBill) {
        total += r.amount;
        activeCount += 1;
      }
    }

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate');
    res.status(200).json({
      total,
      activeCount,
      rowsRead: rows.length,
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};
