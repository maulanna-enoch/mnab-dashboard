// Mirrors Reconcile.gs's rc_undoLastReconciliation. Reverses the most recent
// completed reconciliation for an account (Confirm & Reconcile or Add
// adjustment row -- Back out was never logged, so there's nothing to undo
// there). Refuses if a newer reconciliation has happened since, since
// undoing out of order isn't well-defined.
const {
  getWriteSheetsClient,
  fetchAccountsForReconcile,
  findAccount,
  fetchTransactionsForReconcile,
  unmarkRowsReconciled,
  updateAccountLastReconciled,
  clearAccountLastReconciled,
  getReconciliationLogRows,
  deleteSheetRow,
  formatISODate,
  RECONCILE_SHEETS,
} = require('./_lib/reconcile');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Use POST' });
    return;
  }

  try {
    const { account: accountName } = req.body || {};
    if (!accountName) {
      res.status(400).json({ error: 'account is required' });
      return;
    }

    const sheets = getWriteSheetsClient();
    const { map: accountsColMap, accounts } = await fetchAccountsForReconcile(sheets);
    const account = findAccount(accounts, accountName);
    if (!account) {
      res.status(404).json({ error: `Account "${accountName}" not found.` });
      return;
    }

    const { rows: logRows } = await getReconciliationLogRows(sheets, account.name);
    if (!logRows.length) {
      res.status(400).json({ error: 'No reconciliation history found for this account.' });
      return;
    }

    const entry = logRows[logRows.length - 1];
    const previousEntry = logRows.length > 1 ? logRows[logRows.length - 2] : null;

    if (
      !account.lastReconciledThrough ||
      !entry.periodEnd ||
      formatISODate(account.lastReconciledThrough) !== formatISODate(entry.periodEnd)
    ) {
      res.status(409).json({
        error: 'This account has been reconciled again since this entry -- undoing it now is not safe.',
      });
      return;
    }

    const { map: txnMap, payeeHeader, rows: txnRows } = await fetchTransactionsForReconcile(sheets);
    const periodEndLabel = formatISODate(entry.periodEnd);

    let restoredCount = 0;
    let adjustmentRowNumber = null;
    const toUnmark = [];

    txnRows.forEach((r) => {
      if (!r.sof || r.sof.toLowerCase() !== account.name.toLowerCase()) return;
      if (!r.reconciledDate || formatISODate(r.reconciledDate) !== periodEndLabel) return;
      if (!r.isReconciled) return;

      const isAdjustmentRow =
        entry.adjustmentType &&
        payeeHeader &&
        String(r.payee).trim() === 'Reconciliation' &&
        String(r.notes).trim() === 'Auto-inserted to reconcile against statement';

      if (isAdjustmentRow && adjustmentRowNumber === null) {
        adjustmentRowNumber = r.rowNumber; // delete last, after everything else is processed
      } else {
        toUnmark.push(r.rowNumber);
        restoredCount++;
      }
    });

    await unmarkRowsReconciled(sheets, txnMap, toUnmark);

    let deletedAdjustment = false;
    if (adjustmentRowNumber !== null) {
      await deleteSheetRow(sheets, RECONCILE_SHEETS.transactions, adjustmentRowNumber);
      deletedAdjustment = true;
    }

    if (previousEntry) {
      await updateAccountLastReconciled(sheets, accountsColMap, account.rowNumber, previousEntry.periodEnd, previousEntry.statementAmount);
    } else {
      await clearAccountLastReconciled(sheets, accountsColMap, account.rowNumber);
    }

    await deleteSheetRow(sheets, RECONCILE_SHEETS.log, entry.rowNumber);

    res.status(200).json({ restoredCount, deletedAdjustment });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};
