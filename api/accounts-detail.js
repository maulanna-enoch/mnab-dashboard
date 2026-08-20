// Read-only. Returns one account's transactions (with reconciled status,
// which the general transactions-list endpoint doesn't expose) plus running-
// balance stats, for the Accounts > account detail screen.
const {
  getSheetsClient,
  fetchAccountsForReconcile,
  findAccount,
  fetchTransactionsForReconcile,
  formatISODate,
} = require('./_lib/reconcile');

module.exports = async (req, res) => {
  try {
    const accountName = req.query && req.query.name;
    if (!accountName) {
      res.status(400).json({ error: 'name is required' });
      return;
    }

    const sheets = getSheetsClient();
    const { accounts } = await fetchAccountsForReconcile(sheets);
    const account = findAccount(accounts, accountName);
    if (!account) {
      res.status(404).json({ error: `Account "${accountName}" not found.` });
      return;
    }

    const { rows: txnRows } = await fetchTransactionsForReconcile(sheets);
    const rows = txnRows
      .filter((r) => r.sof && r.sof.toLowerCase() === account.name.toLowerCase())
      .sort((a, b) => {
        if (!a.date && !b.date) return b.rowNumber - a.rowNumber;
        if (!a.date) return 1;
        if (!b.date) return -1;
        return b.date - a.date;
      });

    let clearedTotal = 0;
    let unclearedTotal = 0;
    let unclearedCount = 0;
    rows.forEach((r) => {
      if (r.isCleared) clearedTotal += r.amount;
      else {
        unclearedTotal += r.amount;
        unclearedCount++;
      }
    });

    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({
      account: {
        name: account.name,
        type: account.type,
        lastReconciledThrough: account.lastReconciledThrough ? formatISODate(account.lastReconciledThrough) : null,
        lastReconciledStatement: account.lastReconciledStatement,
      },
      transactions: rows.map((r) => ({
        rowNumber: r.rowNumber,
        payee: r.payee,
        type: r.type,
        date: r.date ? formatISODate(r.date) : null,
        cleared: r.cleared,
        isCleared: r.isCleared,
        reconciled: r.isReconciled,
        amount: r.displayAmount,
      })),
      stats: {
        clearedTotal: Math.round(clearedTotal * 100) / 100,
        unclearedTotal: Math.round(unclearedTotal * 100) / 100,
        runningTotal: Math.round((clearedTotal + unclearedTotal) * 100) / 100,
        unclearedCount,
      },
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};
