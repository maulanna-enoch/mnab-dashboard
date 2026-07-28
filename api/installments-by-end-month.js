const { fetchInstallmentRows } = require('./_lib/sheets');

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function monthKey(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function monthLabel(key) {
  const [y, m] = key.split('-');
  return `${MONTH_NAMES[parseInt(m, 10) - 1]} ${y}`;
}

module.exports = async (req, res) => {
  try {
    const rows = await fetchInstallmentRows();

    const groups = {}; // monthKey -> { amountEnding, items: [{name, amount}] }
    const noEndDateItems = [];
    let totalActive = 0;

    for (const r of rows) {
      if (!r.isActive || r.isBill) continue; // Bills are shown on their own card

      totalActive += r.amount;

      if (!r.hasEndDate) {
        noEndDateItems.push({ name: r.name, amount: r.amount });
        continue;
      }

      const key = monthKey(r.endDate);
      if (!groups[key]) groups[key] = { amountEnding: 0, items: [] };
      groups[key].amountEnding += r.amount;
      groups[key].items.push({ name: r.name, amount: r.amount });
    }

    const sortedKeys = Object.keys(groups).sort();
    let cumulativeEnded = 0;
    const months = sortedKeys.map((key) => {
      cumulativeEnded += groups[key].amountEnding;
      return {
        month: key,
        label: monthLabel(key),
        amountEnding: groups[key].amountEnding,
        count: groups[key].items.length,
        items: groups[key].items,
        remainingAfter: totalActive - cumulativeEnded,
      };
    });

    const noEndDateTotal = noEndDateItems.reduce((sum, i) => sum + i.amount, 0);

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate');
    res.status(200).json({
      totalActive,
      months,
      noEndDate: {
        amount: noEndDateTotal,
        count: noEndDateItems.length,
        items: noEndDateItems,
      },
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};
