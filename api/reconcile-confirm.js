// Mirrors Reconcile.gs's rc_confirmReconcile. Marks the matched incremental
// rows reconciled, updates the Accounts tab, and logs the cycle.
const {
  getWriteSheetsClient,
  fetchAccountsForReconcile,
  findAccount,
  fetchTransactionsForReconcile,
  sumClearedTransactions,
  sumCumulativeClearedTransactions,
  markRowsReconciled,
  updateAccountLastReconciled,
  logReconciliation,
  parseISODate,
  round2,
} = require('./_lib/reconcile');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Use POST' });
    return;
  }

  try {
    const { account: accountName, asOfDate: asOfDateStr, statementAmount } = req.body || {};
    if (!accountName || !asOfDateStr || statementAmount === undefined || statementAmount === null) {
      res.status(400).json({ error: 'account, asOfDate and statementAmount are required' });
      return;
    }
    const numStatementAmount = Number(statementAmount);
    if (Number.isNaN(numStatementAmount)) {
      res.status(400).json({ error: 'statementAmount must be a number' });
      return;
    }

    const asOfDate = parseISODate(asOfDateStr);
    if (!asOfDate) {
      res.status(400).json({ error: 'Invalid date.' });
      return;
    }

    const sheets = getWriteSheetsClient();
    const { map: accountsColMap, accounts } = await fetchAccountsForReconcile(sheets);
    const account = findAccount(accounts, accountName);
    if (!account) {
      res.status(404).json({ error: `Account "${accountName}" not found.` });
      return;
    }

    const { map: txnMap, rows: txnRows } = await fetchTransactionsForReconcile(sheets);
    const sinceDate = account.lastReconciledThrough || new Date(0);
    const { matchedRows } = sumClearedTransactions(txnRows, account.name, sinceDate, asOfDate);
    const { sum: cumulativeSum } = sumCumulativeClearedTransactions(txnRows, account.name, asOfDate);

    await markRowsReconciled(sheets, txnMap, matchedRows, asOfDate);

    await updateAccountLastReconciled(sheets, accountsColMap, account.rowNumber, asOfDate, numStatementAmount);

    await logReconciliation(sheets, {
      account: account.name,
      periodStart: sinceDate,
      periodEnd: asOfDate,
      systemTotal: cumulativeSum,
      statementAmount: numStatementAmount,
      variance: round2(numStatementAmount - cumulativeSum),
      matchedCount: matchedRows.length,
      adjustmentType: null,
      adjustmentAmount: null,
      status: 'Reconciled',
    });

    res.status(200).json({ matchedCount: matchedRows.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};
