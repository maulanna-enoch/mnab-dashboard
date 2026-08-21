// Single consolidated endpoint for all reconciliation actions. Vercel's
// Hobby plan caps a deployment at 12 Serverless Functions total (one per
// file in /api), and this app was already at 10 before reconciliation --
// six separate reconcile-*.js files would have pushed it to 16 and broken
// every deployment. Dispatching on `action` here keeps it to one function
// while still mirroring Reconcile.gs's six server-side callables 1:1 --
// each case below is line-for-line what used to be its own file.
const {
  getSheetsClient,
  getWriteSheetsClient,
  fetchAccountsForReconcile,
  findAccount,
  fetchTransactionsForReconcile,
  sumClearedTransactions,
  sumCumulativeClearedTransactions,
  markRowsReconciled,
  unmarkRowsReconciled,
  appendAdjustmentRow,
  appendPlainTransactionRow,
  updateAccountLastReconciled,
  clearAccountLastReconciled,
  logReconciliation,
  getReconciliationLogRows,
  deleteSheetRow,
  parseISODate,
  parseISOMonth,
  billingMonthForDate,
  formatISODate,
  round2,
  RECONCILE_SHEETS,
} = require('./_lib/reconcile');

// Mirrors Reconcile.gs's rc_getSystemTotal. Read-only.
async function actionCalculate(body, res) {
  const { account: accountName, asOfDate: asOfDateStr } = body || {};
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

  const { matchedRows } = sumClearedTransactions(txnRows, account.name, sinceDate, asOfDate);
  const { sum: cumulativeSum, count: cumulativeCount } = sumCumulativeClearedTransactions(txnRows, account.name, asOfDate);

  res.status(200).json({
    matchedCount: matchedRows.length,
    cumulativeSum,
    cumulativeCount,
    sinceDateLabel: account.lastReconciledThrough ? formatISODate(sinceDate) : '(beginning)',
    sinceDateIso: account.lastReconciledThrough ? formatISODate(sinceDate) : null,
    accountType: account.type,
  });
}

// Mirrors Reconcile.gs's rc_confirmReconcile.
async function actionConfirm(body, res) {
  const { account: accountName, asOfDate: asOfDateStr, statementAmount } = body || {};
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
}

// Mirrors Reconcile.gs's rc_insertAdjustmentAndReconcile.
async function actionAddAdjustment(body, res) {
  const { account: accountName, asOfDate: asOfDateStr, statementAmount } = body || {};
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

  const { map: txnMap, amountHeader, payeeHeader, rows: txnRows } = await fetchTransactionsForReconcile(sheets);
  const sinceDate = account.lastReconciledThrough || new Date(0);
  const { matchedRows } = sumClearedTransactions(txnRows, account.name, sinceDate, asOfDate);
  const { sum: cumulativeSum } = sumCumulativeClearedTransactions(txnRows, account.name, asOfDate);

  const delta = round2(numStatementAmount - cumulativeSum);

  if (delta === 0) {
    await markRowsReconciled(sheets, txnMap, matchedRows, asOfDate);
    await updateAccountLastReconciled(sheets, accountsColMap, account.rowNumber, asOfDate, numStatementAmount);
    await logReconciliation(sheets, {
      account: account.name,
      periodStart: sinceDate,
      periodEnd: asOfDate,
      systemTotal: cumulativeSum,
      statementAmount: numStatementAmount,
      variance: 0,
      matchedCount: matchedRows.length,
      adjustmentType: null,
      adjustmentAmount: null,
      status: 'Reconciled',
    });
    res.status(200).json({ matchedCount: matchedRows.length, amount: 0, type: 'none' });
    return;
  }

  const type = delta > 0 ? 'Expense' : 'Income';
  const amount = Math.abs(delta);
  const newRowNumber = await appendAdjustmentRow(sheets, txnMap, amountHeader, payeeHeader, {
    account: account.name,
    type,
    amount,
    date: asOfDate,
  });

  const allRows = matchedRows.concat([newRowNumber]);
  await markRowsReconciled(sheets, txnMap, allRows, asOfDate);
  await updateAccountLastReconciled(sheets, accountsColMap, account.rowNumber, asOfDate, numStatementAmount);
  await logReconciliation(sheets, {
    account: account.name,
    periodStart: sinceDate,
    periodEnd: asOfDate,
    systemTotal: cumulativeSum,
    statementAmount: numStatementAmount,
    variance: delta,
    matchedCount: allRows.length,
    adjustmentType: type,
    adjustmentAmount: amount,
    status: 'Reconciled via adjustment',
  });

  res.status(200).json({ matchedCount: allRows.length, amount, type });
}

// Mirrors Reconcile.gs's rc_addTransaction.
async function actionAddTransaction(body, res) {
  const { account: accountName, name, type, date: dateStr, amount, month: monthStr } = body || {};

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
}

// Read-only. Returns one account's transactions (with reconciled status,
// which the general transactions-list endpoint doesn't expose) plus
// running-balance stats, for the Accounts > account detail screen. Folded
// in here (rather than its own api/accounts-detail.js) for the same
// Serverless Function count reason as the reconcile-* actions above.
async function actionDetail(query, res) {
  const accountName = query && query.name;
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
}

// Mirrors Reconcile.gs's rc_getLastReconciliation. Read-only.
async function actionLast(query, res) {
  const accountName = query && query.account;
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

  const periodStartIsBeginning = !entry.periodStart || entry.periodStart.getUTCFullYear() < 1971;

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
}

// Mirrors Reconcile.gs's rc_undoLastReconciliation.
async function actionUndo(body, res) {
  const { account: accountName } = body || {};
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
      adjustmentRowNumber = r.rowNumber;
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
}

module.exports = async (req, res) => {
  try {
    const action = (req.method === 'GET' ? req.query && req.query.action : (req.body && req.body.action) || (req.query && req.query.action));

    if (req.method === 'GET') {
      if (action === 'last') return await actionLast(req.query, res);
      if (action === 'detail') return await actionDetail(req.query, res);
      res.status(400).json({ error: 'Unknown or missing GET action. Use ?action=last or ?action=detail.' });
      return;
    }

    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Use GET or POST' });
      return;
    }

    switch (action) {
      case 'calculate':
        return await actionCalculate(req.body, res);
      case 'confirm':
        return await actionConfirm(req.body, res);
      case 'add-adjustment':
        return await actionAddAdjustment(req.body, res);
      case 'add-transaction':
        return await actionAddTransaction(req.body, res);
      case 'undo':
        return await actionUndo(req.body, res);
      default:
        res.status(400).json({ error: 'Unknown or missing action. Use one of: calculate, confirm, add-adjustment, add-transaction, undo.' });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};
