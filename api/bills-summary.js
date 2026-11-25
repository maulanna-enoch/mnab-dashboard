const { fetchInstallmentRows } = require('./_lib/sheets');
const { activeInMonth, currentJakartaMonth } = require('./_lib/bills');

// Bills (cash bills, card bills, and unset open-ended rows) that are due
// this Jakarta month -- Starts/Ends are honoured, so a bill that has ended
// or a price increase that hasn't started yet doesn't count. See
// api/_lib/bills.js.
module.exports = async (req, res) => {
  try {
    const rows = await fetchInstallmentRows();
    const month = currentJakartaMonth();

    let total = 0;
    const items = [];

    for (const r of rows) {
      if (r.isBill && activeInMonth(r, month)) {
        total += r.amount;
        items.push({ id: r.id, name: r.name, amount: r.amount, kind: r.kind });
      }
    }

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate');
    res.status(200).json({
      total,
      count: items.length,
      month,
      items,
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};
