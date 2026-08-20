// Mirrors Reconcile.gs's rc_addTransaction. Adds a real, un-reconciled
// Cleared transaction for something forgotten from the sheet -- it flows
// through the normal matching logic on the next recalculation.
const {
  getWriteSheetsClient,
  fetchTransactionsForReconcile,
  appendPlainTransactionRow,
  parseISODate,
  parseISOMonth,
  billingMonthForDate,
} = require('./_lib/reconcile');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Use POST' });
    return;
  }

  try {
    const { account: accountName, name, type, date: dateStr, amount, month: monthStr } = req.body || {};

    if (!name || !String(name).trim()) {
      res.status(400).json({ error: 'Name is required.' });
      return;
    }
    const numAmount = Number(amount);
    if (Number.isNaN(numAmount) || numAmount <= 0) {
      res.status(400).json({ error: 'Amount must be a positive number.' });
      return;
    }
    if (type !== 'Expense' && type !== 'Income') {
      res.status(400).json({ error: 'Type must be Expense or Income.' });
      return;
    }
    const date = parseISODate(dateStr);
    if (!date) {
      res.status(400).json({ error: 'Invalid date.' });
      return;
    }
    if (!accountName) {
      res.status(400).json({ error: 'account is required.' });
      return;
    }

    const month = monthStr ? parseISOMonth(monthStr) : billingMonthForDate(date);
    if (!month) {
      res.status(400).json({ error: 'Invalid billing month.' });
      return;
    }

    const sheets = getWriteSheetsClient();
    const { map, amountHeader, payeeHeader } = await fetchTransactionsForReconcile(sheets);

    await appendPlainTransactionRow(sheets, map, amountHeader, payeeHeader, {
      name: String(name).trim(),
      sof: accountName,
      type,
      amount: numAmount,
      date,
      month,
    });

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};
