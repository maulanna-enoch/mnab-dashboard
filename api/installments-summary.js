const { fetchInstallmentRows, fetchTransactionRows, fetchSettings, getSheetsClient } = require('./_lib/sheets');
const { fetchAccountsForReconcile, todayWIBDate } = require('./_lib/reconcile');
const { buildBillsPage } = require('./_lib/bills-page');
const { activeInMonth, committedInMonth, currentJakartaMonth, parseMonth, addMonths, monthOf, isOpenEndDate } = require('./_lib/bills');

// Up to Dec 2030 from late 2026 is ~50 months; 72 leaves headroom.
const MAX_COMMITTED_MONTHS = 72;

// GET ?action=registry (WS1) -- every installmentsbills row that has its
// permanent IB-n ID, for the transaction form's "is this a bill?"
// suggestion (see suggestBills in api/_lib/kinds.js). Lives here because
// the 12-function cap is full. WS2 adds kind / starts / ends / totalMonths.
async function actionRegistry(res) {
  const rows = await fetchInstallmentRows();
  const bills = rows
    .filter((r) => r.id)
    .map((r) => ({
      id: r.id,
      name: r.name,
      sof: r.sof,
      amount: r.amount,
      isActive: r.isActive,
      isBill: r.isBill,
      kind: r.kind,
      kindSet: r.kindSet,
      dayOfMonth: r.dayOfMonth,
      startsMonth: r.startDate ? monthOf(r.startDate) : null,
      endsMonth: isOpenEndDate(r.endDate) ? null : monthOf(r.endDate),
      totalMonths: r.totalMonths,
    }));
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate');
  res.status(200).json({ bills, updatedAt: new Date().toISOString() });
}

// GET ?action=committed[&from=YYYY-MM][&months=N] (WS2) -- what the
// registry commits in each month: totals overall and per Kind, plus the
// rows. `from` defaults to this Jakarta month, `months` to 1 (max 72).
// This is what WS3 (drop-off timeline, committed as % of salary) and WS6
// (debt projection) read. Lives here because the 12-function cap is full.
async function actionCommitted(req, res) {
  const q = req.query || {};
  const from = q.from ? parseMonth(q.from) : currentJakartaMonth();
  if (!from) {
    res.status(400).json({ error: 'Bad "from": use YYYY-MM, e.g. ?from=2027-01' });
    return;
  }
  const n = q.months === undefined ? 1 : Number(q.months);
  if (!Number.isInteger(n) || n < 1 || n > MAX_COMMITTED_MONTHS) {
    res.status(400).json({ error: `Bad "months": a whole number from 1 to ${MAX_COMMITTED_MONTHS}` });
    return;
  }
  const rows = await fetchInstallmentRows();
  const months = [];
  for (let i = 0; i < n; i += 1) months.push(committedInMonth(rows, addMonths(from, i)));
  const unsetKinds = rows.filter((r) => r.isActive && !r.kindSet).length;
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate');
  res.status(200).json({ from, months, unsetKinds, updatedAt: new Date().toISOString() });
}

// GET ?action=page (WS3) -- everything the Bills page shows, in one
// request: this pay cycle's checklist (bills, installments and card
// statements, each Paid / Due soon / Late), the per-kind sections, recent
// card statements, the drop-off timeline and committed-as-%-of-salary.
// Rules in api/_lib/bills-page.js. Lives here because the 12-function cap
// is full.
async function actionPage(res) {
  const sheets = getSheetsClient();
  const [registry, txns, { accounts }, settings] = await Promise.all([
    fetchInstallmentRows(),
    fetchTransactionRows(),
    fetchAccountsForReconcile(sheets),
    fetchSettings(sheets),
  ]);
  const salary = settings && settings.values ? settings.values.monthly_salary_rp : null;
  const page = buildBillsPage({ registry, txns, accounts, salary, today: todayWIBDate() });
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({ ...page, updatedAt: new Date().toISOString() });
}

module.exports = async (req, res) => {
  try {
    if (req.query && req.query.action === 'page') return await actionPage(res);
    if (req.query && req.query.action === 'registry') return await actionRegistry(res);
    if (req.query && req.query.action === 'committed') return await actionCommitted(req, res);

    const rows = await fetchInstallmentRows();
    const month = currentJakartaMonth();

    let total = 0;
    let activeCount = 0;

    // Installments that pay this month (Starts..Ends cover it).
    for (const r of rows) {
      if (!r.isBill && activeInMonth(r, month)) {
        total += r.amount;
        activeCount += 1;
      }
    }

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate');
    res.status(200).json({
      total,
      activeCount,
      month,
      rowsRead: rows.length,
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};
