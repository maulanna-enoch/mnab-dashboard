const { fetchAccountRows } = require('./_lib/sheets');

module.exports = async (req, res) => {
  try {
    const accounts = await fetchAccountRows();
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate');
    res.status(200).json({ accounts, updatedAt: new Date().toISOString() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};
