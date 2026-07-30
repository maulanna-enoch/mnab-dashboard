const { fetchDiaryRows, monthLabel } = require('./_lib/sheets');

module.exports = async (req, res) => {
  try {
    const rows = await fetchDiaryRows();
    const monthSet = new Set(rows.filter((r) => r.month).map((r) => r.month));
    const months = Array.from(monthSet)
      .sort()
      .reverse() // most recent first
      .map((value) => ({ value, label: monthLabel(value) }));

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate');
    res.status(200).json({ months, updatedAt: new Date().toISOString() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};
