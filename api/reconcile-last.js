// Mirrors Reconcile.gs's rc_getLastReconciliation. Read-only -- powers the
// "View / undo last reconciliation" screen.
const {
  getSheetsClient,
  fetchAccountsForReconcile,
  findAccount,
  getReconciliationLogRows,
  formatISODate,
} = require('./_lib/reconcile');

module.exports = async (req, res) => {
  try {
    const accountName = req.query && req.query.account;
    if (!accountName) {
      res.status(400).json({ error: 'account is required' });
      return;
    }

    const sheets = getSheetsClient();
    const { accounts } = await fetchAccountsForReconcile(sheets);
    const account = findAccount(accounts, accountName);
    if (!account) {
      res.status(404).json({ error: `Account "${accountName}" not found.` });
      return;
    }

    const { rows } = await getReconciliationLogRows(sheets, account.name);
    if (!rows.length) {
      res.status(200).json({ found: false });
      return;
    }

    const entry = rows[rows.length - 1];
    const isCurrent =
      account.lastReconciledThrough &&
      entry.periodEnd &&
      formatISODate(account.lastReconciledThrough) === formatISODate(entry.periodEnd);

    // The macro's "(beginning)" case wrote new Date(0) (epoch) as the period
    // start; after round-tripping through the sheet's date serial that reads
    // back as very early 1970 -- treat anything before 1971 as "(beginning)"
    // rather than trying to match an exact instant.
    const periodStartIsBeginning =
      !entry.periodStart || entry.periodStart.getUTCFullYear() < 1971;

    res.status(200).json({
      found: true,
      periodStartLabel: periodStartIsBeginning ? '(beginning)' : formatISODate(entry.periodStart),
      periodEndLabel: entry.periodEnd ? formatISODate(entry.periodEnd) : '',
      systemTotal: entry.systemTotal,
      statementAmount: entry.statementAmount,
      variance: entry.variance,
      matchedCount: entry.matchedCount,
      adjustmentType: entry.adjustmentType,
      adjustmentAmount: entry.adjustmentAmount,
      isCurrent: !!isCurrent,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};
