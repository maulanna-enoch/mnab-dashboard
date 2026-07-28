const { fetchInstallmentRows } = require('./_lib/sheets');

module.exports = async (req, res) => {
  try {
    const rows = await fetchInstallmentRows();

    let total = 0;
    const items = [];

    for (const r of rows) {
      if (r.isActive && r.isBill) {
        total += r.amount;
        items.push({ name: r.name, amount: r.amount });
      }
    }

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate');
    res.status(200).json({
      total,
      count: items.length,
      items,
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};
