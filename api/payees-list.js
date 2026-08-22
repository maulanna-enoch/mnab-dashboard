const { fetchTransactionRows } = require('./_lib/sheets');

// Powers the Payee field's autocomplete (see transaction-form.js) -- returns
// the distinct payee names already used across past transactions, most
// recently used first, so the suggestion list favors recent/frequent payees
// over a plain alphabetical dump.
module.exports = async (req, res) => {
  try {
    const rows = await fetchTransactionRows();

    const sorted = rows.slice().sort((a, b) => {
      if (!a.date && !b.date) return b.rowNumber - a.rowNumber;
      if (!a.date) return 1;
      if (!b.date) return -1;
      return b.date - a.date;
    });

    const seen = new Set();
    const payees = [];
    sorted.forEach((r) => {
      const name = (r.payee || '').trim();
      if (!name) return;
      const key = name.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      payees.push(name);
    });

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate');
    res.status(200).json({ payees, updatedAt: new Date().toISOString() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};
