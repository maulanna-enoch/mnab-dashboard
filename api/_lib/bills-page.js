// The Bills page (Debt Exit plan WS3), worked out in one pass so the page
// makes a single request. Pure: no Sheets API, so it's testable in Node.
//
// Inputs:
//   registry  fetchInstallmentRows() rows (api/_lib/bills.js has the rules)
//   txns      fetchTransactionRows() rows (billId = Source ID, isPending,
//             isTransfer, type, amount > 0, sof, month 'YYYY-MM', date)
//   accounts  fetchAccountsForReconcile() accounts (type, statementDueDay)
//   salary    Settings monthly_salary_rp, or null
//   today     a Jakarta calendar day as a UTC-midnight Date
//
// Pay cycle: pay lands on the 25th (PAYROLL_DAY, same as api/_lib/morning.js
// and public/index.html). "Before next payroll" means due on or after the
// last 25th and before the next one.
//
// A bill or installment counts as paid for one due date when a transaction
// carries its Bill ID (Source ID), isn't Pending (an auto-inserted row stays
// Pending until you confirm it), and is dated after the previous due date
// and before the next one -- so an early or a late payment both count.
// Card statements come from api/_lib/statements.js.
//
// Every date out of here is 'YYYY-MM-DD'; every month is 'YYYY-MM'.

const { activeInMonth, committedInMonth, isOpenEndDate, monthOf, addMonths, totalMonths, installmentNumber,
  KIND_CASH_BILL, KIND_CARD_BILL, KIND_INSTALLMENT } = require('./bills');
const { statementsFor, STATUS_BILLED, STATUS_PAID } = require('./statements');

const PAYROLL_DAY = 25;
const DUE_SOON_DAYS = 3;
const MISMATCH_TOLERANCE = 0.5;
const COMMITTED_MONTHS = 13; // this month + the next 12
const DROP_OFF_MONTHS = 60; // about five years ahead, past 2030
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const STATUS_LATE = 'late';
const STATUS_DUE_SOON = 'due-soon';
const STATUS_UPCOMING = 'upcoming';
const STATUS_PAID_ITEM = 'paid';

function utcDay(y, m0, d) {
  return new Date(Date.UTC(y, m0, d));
}

function clampedDay(y, m0, d) {
  const last = utcDay(y, m0 + 1, 0).getUTCDate();
  return utcDay(y, m0, Math.min(d, last));
}

function iso(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function parseIsoDay(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
  return m ? utcDay(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

function monthsBetween(fromMonth, toMonth) {
  const [fy, fm] = fromMonth.split('-').map(Number);
  const [ty, tm] = toMonth.split('-').map(Number);
  return (ty - fy) * 12 + (tm - fm);
}

// The pay cycle `today` is in: [start, payroll).
function payCycle(today) {
  const y = today.getUTCFullYear();
  const m0 = today.getUTCMonth();
  const start = today.getUTCDate() >= PAYROLL_DAY ? utcDay(y, m0, PAYROLL_DAY) : utcDay(y, m0 - 1, PAYROLL_DAY);
  const payroll = utcDay(start.getUTCFullYear(), start.getUTCMonth() + 1, PAYROLL_DAY);
  return { start, payroll };
}

// The one occurrence of `day` (clamped to month length) in [start, payroll).
function dueDateInCycle(day, cycle) {
  const d = Math.max(1, Math.min(Number(day) || 1, 31));
  const a = clampedDay(cycle.start.getUTCFullYear(), cycle.start.getUTCMonth(), d);
  if (a >= cycle.start && a < cycle.payroll) return a;
  const b = clampedDay(cycle.payroll.getUTCFullYear(), cycle.payroll.getUTCMonth(), d);
  return b >= cycle.start && b < cycle.payroll ? b : null;
}

function dueStatus(dueDate, today, paid) {
  if (paid) return STATUS_PAID_ITEM;
  if (today > dueDate) return STATUS_LATE;
  if ((dueDate - today) / MS_PER_DAY <= DUE_SOON_DAYS) return STATUS_DUE_SOON;
  return STATUS_UPCOMING;
}

// Confirmed payments for one bill around one due date.
function paymentsFor(txnsByBill, billId, dueDate, dayOfMonth) {
  const list = txnsByBill.get(billId) || [];
  const prevDue = clampedDay(dueDate.getUTCFullYear(), dueDate.getUTCMonth() - 1, dayOfMonth);
  const nextDue = clampedDay(dueDate.getUTCFullYear(), dueDate.getUTCMonth() + 1, dayOfMonth);
  return list.filter((t) => t.date > prevDue && t.date < nextDue);
}

function indexTxnsByBill(txns) {
  const byBill = new Map();
  txns.forEach((t) => {
    if (!t.billId || !t.date) return;
    const key = String(t.billId).trim().toUpperCase();
    if (!byBill.has(key)) byBill.set(key, []);
    byBill.get(key).push(t);
  });
  return byBill;
}

function billItem(r, { cycle, today, txnsByBill }) {
  const item = {
    id: r.id,
    name: r.name,
    kind: r.kind,
    sof: r.sof,
    amount: r.amount,
    dayOfMonth: r.dayOfMonth,
    endsMonth: isOpenEndDate(r.endDate) ? null : monthOf(r.endDate),
  };
  const due = r.dayOfMonth ? dueDateInCycle(r.dayOfMonth, cycle) : null;
  if (!due || !activeInMonth(r, monthOf(due))) return { item, due: null };

  const confirmed = r.id ? paymentsFor(txnsByBill, String(r.id).toUpperCase(), due, r.dayOfMonth) : [];
  const done = confirmed.filter((t) => !t.isPending);
  const paidAmount = done.reduce((s, t) => s + (Number(t.amount) || 0), 0);
  item.dueDate = iso(due);
  item.status = dueStatus(due, today, done.length > 0);
  item.awaitingConfirm = done.length === 0 && confirmed.some((t) => t.isPending);
  if (done.length) {
    item.paidAmount = paidAmount;
    item.paidDate = iso(done.map((t) => t.date).sort((a, b) => b - a)[0]);
    item.mismatch = Math.abs(paidAmount - r.amount) >= MISMATCH_TOLERANCE;
  }
  if (r.kind === KIND_INSTALLMENT) {
    item.installment = installmentNumber(r, monthOf(due));
    item.totalMonths = totalMonths(r);
  }
  return { item, due };
}

// Rows from fetchTransactionRows(), shaped the way statementFor() reads
// them (amount signed like Total: Income negative).
function statementRows(txns) {
  return txns.map((t) => ({
    sof: t.sof,
    month: t.month,
    type: t.type,
    isTransfer: t.isTransfer,
    amount: t.type === 'Income' ? -(Number(t.amount) || 0) : (Number(t.amount) || 0),
  }));
}

function buildBillsPage({ registry, txns, accounts, salary, today }) {
  const cycle = payCycle(today);
  const thisMonth = monthOf(today);
  const txnsByBill = indexTxnsByBill(txns);

  // ---- this cycle's checklist + per-kind sections ----
  const checklist = [];
  const sections = { cashBills: [], cardBills: [], otherBills: [], installments: [] };
  registry.forEach((r) => {
    if (!r.isActive) return;
    const { item, due } = billItem(r, { cycle, today, txnsByBill });
    if (due) checklist.push(item);
    // Sections list what's running now: active this month, or due in this
    // cycle (a cycle can straddle two months).
    if (!due && !activeInMonth(r, thisMonth)) return;
    if (r.kind === KIND_INSTALLMENT) {
      const ends = item.endsMonth;
      const left = ends ? monthsBetween(thisMonth, ends) + 1 : null;
      item.paymentsLeft = left;
      item.remainingTotal = left !== null ? left * r.amount : null;
      if (item.installment === undefined) {
        item.installment = installmentNumber(r, thisMonth);
        item.totalMonths = totalMonths(r);
      }
      sections.installments.push(item);
    } else if (r.kind === KIND_CASH_BILL) sections.cashBills.push(item);
    else if (r.kind === KIND_CARD_BILL) sections.cardBills.push(item);
    else sections.otherBills.push(item);
  });
  sections.installments.sort((a, b) => (a.endsMonth || '9999').localeCompare(b.endsMonth || '9999'));

  // ---- card statements: the open one and the two before it ----
  // The open statement is this month's until the 12th closes it, then
  // next month's. Empty ones (no rows at all) are left out.
  const openMonth = today.getUTCDate() <= 12 ? thisMonth : addMonths(thisMonth, 1);
  const statements = statementsFor(statementRows(txns), accounts, { toMonth: openMonth, months: 3, today })
    .filter((s) => s.chargeCount || s.paymentCount);
  statements.forEach((s) => {
    if (s.status !== STATUS_BILLED && s.status !== STATUS_PAID) return;
    // In the checklist when it's due in this cycle; with no due day set,
    // when it closed in this cycle or is still unpaid.
    const due = parseIsoDay(s.dueDate);
    const close = parseIsoDay(s.closeDate);
    const inCycle = due
      ? due >= cycle.start && due < cycle.payroll
      : (close >= cycle.start && close < cycle.payroll) || s.status === STATUS_BILLED;
    const overdueUnpaid = due && due < cycle.start && s.status === STATUS_BILLED;
    if (!inCycle && !overdueUnpaid) return;
    checklist.push({
      id: null,
      name: `${s.card} statement`,
      kind: 'Card statement',
      sof: s.card,
      amount: s.amount,
      statementMonth: s.month,
      dueDate: s.dueDate,
      status: s.status === STATUS_PAID ? STATUS_PAID_ITEM : (due ? dueStatus(due, today, false) : STATUS_UPCOMING),
      paidAmount: s.paid,
      remaining: s.remaining,
    });
  });

  const order = { [STATUS_LATE]: 0, [STATUS_DUE_SOON]: 1, [STATUS_UPCOMING]: 2, [STATUS_PAID_ITEM]: 3 };
  checklist.sort((a, b) => order[a.status] - order[b.status] || String(a.dueDate || '9999').localeCompare(String(b.dueDate || '9999')));
  const unpaid = checklist.filter((i) => i.status !== STATUS_PAID_ITEM);
  const leftToPay = unpaid.reduce((s, i) => s + (i.remaining !== undefined ? i.remaining : i.amount), 0);

  // ---- drop-off timeline: when rows end and what they free up ----
  const horizon = addMonths(thisMonth, DROP_OFF_MONTHS);
  const groups = new Map();
  registry.forEach((r) => {
    if (!r.isActive || isOpenEndDate(r.endDate)) return;
    const ends = monthOf(r.endDate);
    if (ends < thisMonth || ends > horizon) return;
    if (!activeInMonth(r, ends)) return; // e.g. an installment missing Starts
    if (!groups.has(ends)) groups.set(ends, { endsMonth: ends, freedFrom: addMonths(ends, 1), amount: 0, items: [] });
    const g = groups.get(ends);
    g.amount += r.amount;
    g.items.push({ id: r.id, name: r.name, kind: r.kind, amount: r.amount });
  });
  const dropOff = Array.from(groups.values()).sort((a, b) => a.endsMonth.localeCompare(b.endsMonth));

  // ---- committed as % of salary, this month and the next 12 ----
  const committed = [];
  for (let i = 0; i < COMMITTED_MONTHS; i += 1) {
    const c = committedInMonth(registry, addMonths(thisMonth, i));
    committed.push({
      month: c.month,
      total: c.total,
      byKind: c.byKind,
      pctOfSalary: salary ? Math.round((c.total / salary) * 1000) / 10 : null,
    });
  }

  return {
    today: iso(today),
    cycle: { start: iso(cycle.start), payroll: iso(cycle.payroll) },
    leftToPay,
    unpaidCount: unpaid.length,
    lateCount: checklist.filter((i) => i.status === STATUS_LATE).length,
    checklist,
    sections,
    statements,
    dropOff,
    committed,
    salarySet: !!salary,
    unsetKinds: registry.filter((r) => r.isActive && !r.kindSet).length,
  };
}

module.exports = {
  PAYROLL_DAY,
  payCycle,
  dueDateInCycle,
  buildBillsPage,
};
