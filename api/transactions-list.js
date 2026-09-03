const { fetchTransactionRows } = require('./_lib/sheets');

module.exports = async (req, res) => {
  try {
    const rows = await fetchTransactionRows();

    const sorted = rows.slice().sort((a, b) => {
      if (!a.date && !b.date) return b.rowNumber - a.rowNumber;
      if (!a.date) return 1;
      if (!b.date) return -1;
      return b.date - a.date;
    });

    // Always fresh -- this list changes as you add/edit/delete, unlike the
    // mostly-static read pages, so no CDN caching here.
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({
      transactions: sorted.map((r) => ({
        rowNumber: r.rowNumber,
        payee: r.payee,
        type: r.type,
        sof: r.sof,
        date: r.date ? r.date.toISOString().slice(0, 10) : null,
        month: r.month,
        cleared: r.isCleared ? 'Cleared' : 'Uncleared',
        amount: r.amount,
        notes: r.notes,
        pending: r.isPending,
      })),
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};
