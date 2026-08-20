// Mirrors Reconcile.gs's rc_getSystemTotal. Read-only.
const {
  getSheetsClient,
  fetchAccountsForReconcile,
  findAccount,
  fetchTransactionsForReconcile,
  sumClearedTransactions,
  sumCumulativeClearedTransactions,
  parseISODate,
  formatISODate,
} = require('./_lib/reconcile');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Use POST' });
    return;
  }

  try {
    const { account: accountName, asOfDate: asOfDateStr } = req.body || {};
    if (!accountName || !asOfDateStr) {
      res.status(400).json({ error: 'account and asOfDate are required' });
      return;
    }

    const asOfDate = parseISODate(asOfDateStr);
    if (!asOfDate) {
      res.status(400).json({ error: 'Invalid date.' });
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
    const sinceDate = account.lastReconciledThrough || new Date(0);

    const { matchedRows, sum } = sumClearedTransactions(txnRows, account.name, sinceDate, asOfDate);
    const { sum: cumulativeSum, count: cumulativeCount } = sumCumulativeClearedTransactions(txnRows, account.name, asOfDate);

    res.status(200).json({
      sum,
      matchedCount: matchedRows.length,
      cumulativeSum,
      cumulativeCount,
      sinceDateLabel: account.lastReconciledThrough ? formatISODate(sinceDate) : '(beginning)',
      sinceDateIso: account.lastReconciledThrough ? formatISODate(sinceDate) : null,
      accountType: account.type,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};
