// The Bills page (Debt Exit plan WS3), worked out in one pass so the page
// makes a single request. Pure: no Sheets API, so it's testable in Node.
//
// The page has three views, one question each:
//   cycle        "What do I have to pay before payroll, and what's done?"
//                Only money leaving a cash account: bills paid from cash
//                and card statements. Anything charged to a card is listed
//                inside the statement it lands on, never as its own item,
//                so nothing is counted twice.
//   commitments  "What am I signed up for?" Grouped by how it's paid:
//                from cash, or on each card (with that card's statements).
//   outlook      "When does it get lighter?" Committed as % of salary for
//                13 months, and the drop-off timeline that explains it.
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
// and public/index.html). "Before payroll" means due on or after the last
// 25th and before the next one.
//
// A registry row is "on a card" when its SOF is a credit card account
// (Accounts Type contains "credit"); otherwise it's paid from cash. Kind
// only decides how a row is described (installments get n/total).
//
// A cash item counts as paid for one due date when a transaction carries
// its Bill ID (Source ID), isn't Pending (an auto-inserted row stays Pending
// until you confirm it), and is dated after the previous due date and before
// the next one -- so an early or a late payment both count. A card item is
// "charged" by the same test around its charge date. Card statements come
// from api/_lib/statements.js.
//
// An unpaid cash bill also carries `payTxn` when that window holds a still-
// Pending auto-insert row: the page's Pay button opens that row (dated
// today) instead of adding a second one, so paying before the due date
// never leaves the auto-insert behind as a duplicate.
//
// Every date out of here is 'YYYY-MM-DD'; every month is 'YYYY-MM'.

const { activeInMonth, inDateRange, committedInMonth, isOpenEndDate, monthOf, addMonths, totalMonths, installmentNumber,
  KIND_INSTALLMENT } = require('./bills');
const { statementsFor, isCreditCardType, STATEMENT_CLOSE_DAY, STATUS_BILLED, STATUS_PAID } = require('./statements');

const PAYROLL_DAY = 25;
const DUE_SOON_DAYS = 3;
const MISMATCH_TOLERANCE = 0.5;
const COMMITTED_MONTHS = 13; // this month + the next 12
const DROP_OFF_MONTHS = 60; // about five years ahead, past 2030
const STATEMENT_HISTORY = 3; // open statement + the two before it
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const STATUS_LATE = 'late';
const STATUS_DUE_SOON = 'due-soon';
const STATUS_UPCOMING = 'upcoming';
const STATUS_PAID_ITEM = 'paid';
const STATUS_CHARGED = 'charged';
const STATUS_EXPECTED = 'expected';

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

function sameName(a, b) {
  return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
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

// When a card item with this day of month is charged for statement `month`:
// on or before the 12th it's in that month, after it in the month before
// (the billing-month rule in api/_lib/reconcile.js).
function chargeDateForStatement(day, month) {
  const [y, m] = month.split('-').map(Number);
  const d = Math.max(1, Math.min(Number(day) || 1, 31));
  return d <= STATEMENT_CLOSE_DAY ? clampedDay(y, m - 1, d) : clampedDay(y, m - 2, d);
}

function dueStatus(dueDate, today, paid) {
  if (paid) return STATUS_PAID_ITEM;
  if (today > dueDate) return STATUS_LATE;
  if ((dueDate - today) / MS_PER_DAY <= DUE_SOON_DAYS) return STATUS_DUE_SOON;
  return STATUS_UPCOMING;
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

// A row's transactions around one due (or charge) date: after the previous
// occurrence and before the next. { done: confirmed rows, pending: bool }.
function matchAround(txnsByBill, r, date) {
  if (!r.id) return { done: [], pending: false };
  const list = txnsByBill.get(String(r.id).trim().toUpperCase()) || [];
  const prev = clampedDay(date.getUTCFullYear(), date.getUTCMonth() - 1, r.dayOfMonth);
  const next = clampedDay(date.getUTCFullYear(), date.getUTCMonth() + 1, r.dayOfMonth);
  const around = list.filter((t) => t.date > prev && t.date < next);
  const pendingRows = around.filter((t) => t.isPending).sort((a, b) => b.date - a.date);
  return { done: around.filter((t) => !t.isPending), pending: pendingRows.length > 0, pendingRows };
}

// A Pending row in the shape /api/transactions-list returns, so the page can
// hand it straight to TransactionForm.open() as an edit.
function editableTxn(t) {
  return {
    rowNumber: t.rowNumber,
    payee: t.payee,
    type: t.type,
    sof: t.sof,
    date: t.date ? iso(t.date) : null,
    month: t.month,
    cleared: t.isCleared ? 'Cleared' : 'Uncleared',
    amount: t.amount,
    notes: t.notes,
    pending: true,
    matchId: t.matchId,
    matchStatus: t.matchStatus,
    transfer: t.isTransfer,
    paymentId: t.paymentId,
    kind: t.storedKind,
    kindRule: t.storedKindRule,
    billId: t.billId,
  };
}

// What every view says about a registry row, whatever the date.
function baseItem(r, thisMonth) {
  const item = {
    id: r.id,
    name: r.name,
    kind: r.kind,
    sof: r.sof,
    amount: r.amount,
    dayOfMonth: r.dayOfMonth,
    endsMonth: isOpenEndDate(r.endDate) ? null : monthOf(r.endDate),
  };
  if (r.kind === KIND_INSTALLMENT) {
    item.installment = installmentNumber(r, thisMonth);
    item.totalMonths = totalMonths(r);
    const left = item.endsMonth ? monthsBetween(thisMonth, item.endsMonth) + 1 : null;
    item.paymentsLeft = left;
    item.remainingTotal = left !== null ? left * r.amount : null;
  }
  return item;
}

function withPayment(item, r, match) {
  if (match.done.length) {
    const paid = match.done.reduce((s, t) => s + (Number(t.amount) || 0), 0);
    item.paidAmount = paid;
    item.paidDate = iso(match.done.map((t) => t.date).sort((a, b) => b - a)[0]);
    item.mismatch = Math.abs(paid - r.amount) >= MISMATCH_TOLERANCE;
  } else {
    item.awaitingConfirm = match.pending;
    if (match.pendingRows && match.pendingRows.length) item.payTxn = editableTxn(match.pendingRows[0]);
  }
  return item;
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

// The card items that land on one card's statement for `month`.
//
// `cardRows` includes switched-off rows (is_active FALSE). An installment's
// row is usually switched off once its last payment is charged, but that
// last payment is still on the statement, so a switched-off row stays in
// when the statement's charge falls inside its Starts..Ends and either it
// is the Ends month (the final payment) or a transaction with its Bill ID
// was charged around that date. Otherwise it's left out, so a row switched
// off early (paid off, cancelled) doesn't keep showing as expected.
function statementContents(cardRows, month, ctx) {
  const items = [];
  cardRows.forEach((r) => {
    if (!r.dayOfMonth) return;
    const charge = chargeDateForStatement(r.dayOfMonth, month);
    const chargeMonth = monthOf(charge);
    const match = matchAround(ctx.txnsByBill, r, charge);
    if (!r.isActive) {
      if (!inDateRange(r, chargeMonth)) return;
      const finalPayment = !isOpenEndDate(r.endDate) && monthOf(r.endDate) === chargeMonth;
      if (!finalPayment && !match.done.length && !match.pending) return;
    } else if (!activeInMonth(r, chargeMonth)) {
      return;
    }
    const item = withPayment(baseItem(r, chargeMonth), r, match);
    delete item.payTxn; // charged to the card -- nothing to pay from here
    item.chargeDate = iso(charge);
    item.status = item.paidAmount !== undefined ? STATUS_CHARGED : STATUS_EXPECTED;
    items.push(item);
  });
  return items.sort((a, b) => a.chargeDate.localeCompare(b.chargeDate));
}

// Active registry rows the page can't place, with why. A row with no Day
// of Month never shows up in a pay cycle; an Installment (set, or the
// fallback for a blank Kind with no 2099 Ends) without both Starts and
// Ends never counts in any month.
function needsAttention(active) {
  const out = [];
  active.forEach((r) => {
    const reasons = [];
    if (!r.dayOfMonth) reasons.push('no Day of Month, so it never shows in a pay cycle');
    if (!r.isBill && (!r.startDate || !r.endDate)) {
      reasons.push(r.kindSet
        ? 'an Installment needs both Starts and Ends'
        : 'no Kind and no Starts/Ends, so it reads as an Installment that never runs; set Kind to Cash bill or Card bill');
    } else if (!r.kindSet) {
      reasons.push('no Kind set');
    }
    if (reasons.length) out.push({ id: r.id, name: r.name, reasons });
  });
  return out;
}

function buildBillsPage({ registry, txns, accounts, salary, today }) {
  const cycle = payCycle(today);
  const thisMonth = monthOf(today);
  const ctx = { txnsByBill: indexTxnsByBill(txns) };
  const cards = accounts.filter((a) => isCreditCardType(a.type));
  const cardOf = (sof) => cards.find((c) => sameName(c.name, sof)) || null;
  const active = registry.filter((r) => r.isActive);
  const cashRows = active.filter((r) => !cardOf(r.sof));
  const rowsOnCard = (card) => active.filter((r) => sameName(r.sof, card.name));

  // ---- statements per card: the open one and the two before it ----
  // The open statement is this month's until the 12th closes it, then
  // next month's.
  const openMonth = today.getUTCDate() <= STATEMENT_CLOSE_DAY ? thisMonth : addMonths(thisMonth, 1);
  const statements = statementsFor(statementRows(txns), accounts, { toMonth: openMonth, months: STATEMENT_HISTORY, today });

  // ---- cycle: cash bills due before payroll + card statements ----
  const pay = [];
  cashRows.forEach((r) => {
    const due = r.dayOfMonth ? dueDateInCycle(r.dayOfMonth, cycle) : null;
    if (!due || !activeInMonth(r, monthOf(due))) return;
    const item = withPayment(baseItem(r, monthOf(due)), r, matchAround(ctx.txnsByBill, r, due));
    item.type = 'bill';
    item.dueDate = iso(due);
    item.status = dueStatus(due, today, item.paidAmount !== undefined);
    pay.push(item);
  });
  cards.forEach((card) => {
    statements.filter((s) => sameName(s.card, card.name)).forEach((s) => {
      if (s.status !== STATUS_BILLED && s.status !== STATUS_PAID) return;
      // In the list when it's due in this cycle, or overdue and unpaid.
      // With no Statement Due Day: when it closed in this cycle, or is
      // still unpaid.
      const due = parseIsoDay(s.dueDate);
      const close = parseIsoDay(s.closeDate);
      const inCycle = due
        ? due >= cycle.start && due < cycle.payroll
        : (close >= cycle.start && close < cycle.payroll) || s.status === STATUS_BILLED;
      const overdueUnpaid = !!due && due < cycle.start && s.status === STATUS_BILLED;
      if (!inCycle && !overdueUnpaid) return;
      pay.push({
        type: 'statement',
        name: `${s.card} statement`,
        sof: s.card,
        statementMonth: s.month,
        amount: s.amount,
        paidAmount: s.paid,
        remaining: s.remaining,
        dueDate: s.dueDate,
        status: s.status === STATUS_PAID ? STATUS_PAID_ITEM : (due ? dueStatus(due, today, false) : STATUS_UPCOMING),
        // All rows on the card, switched-off ones included: statementContents
      // decides which of those were still charged to this statement.
      contents: statementContents(registry.filter((r) => sameName(r.sof, card.name)), s.month, ctx),
      });
    });
  });
  // Unpaid first (late, due soon, upcoming; then by due date), paid last.
  const order = { [STATUS_LATE]: 0, [STATUS_DUE_SOON]: 1, [STATUS_UPCOMING]: 2, [STATUS_PAID_ITEM]: 3 };
  pay.sort((a, b) => order[a.status] - order[b.status] || String(a.dueDate || '9999').localeCompare(String(b.dueDate || '9999')));
  const unpaid = pay.filter((i) => i.status !== STATUS_PAID_ITEM);
  const leftToPay = unpaid.reduce((s, i) => s + (i.type === 'statement' ? i.remaining : i.amount), 0);

  // ---- commitments: from cash, and on each card ----
  const runningNow = (r) => activeInMonth(r, thisMonth) || activeInMonth(r, addMonths(thisMonth, 1));
  const byDay = (a, b) => (a.dayOfMonth || 99) - (b.dayOfMonth || 99);
  const fromCash = cashRows.filter(runningNow).map((r) => baseItem(r, thisMonth)).sort(byDay);
  const onCards = cards.map((card) => {
    const items = rowsOnCard(card).filter(runningNow).map((r) => baseItem(r, thisMonth)).sort(byDay);
    return {
      card: card.name,
      statementDueDay: card.statementDueDay,
      monthly: items.reduce((s, i) => s + i.amount, 0),
      items,
      statements: statements.filter((s) => sameName(s.card, card.name) && (s.chargeCount || s.paymentCount)),
    };
  }).filter((c) => c.items.length || c.statements.length);

  // ---- outlook: committed as % of salary + what ends when ----
  const committed = [];
  for (let i = 0; i < COMMITTED_MONTHS; i += 1) {
    const c = committedInMonth(registry, addMonths(thisMonth, i));
    committed.push({
      month: c.month,
      total: c.total,
      pctOfSalary: salary ? Math.round((c.total / salary) * 1000) / 10 : null,
    });
  }
  const horizon = addMonths(thisMonth, DROP_OFF_MONTHS);
  const groups = new Map();
  active.forEach((r) => {
    if (isOpenEndDate(r.endDate)) return;
    const ends = monthOf(r.endDate);
    if (ends < thisMonth || ends > horizon) return;
    if (!activeInMonth(r, ends)) return; // e.g. an installment missing Starts
    if (!groups.has(ends)) groups.set(ends, { endsMonth: ends, freedFrom: addMonths(ends, 1), amount: 0, items: [] });
    const g = groups.get(ends);
    g.amount += r.amount;
    g.items.push({ id: r.id, name: r.name, kind: r.kind, sof: r.sof, amount: r.amount });
  });
  let freed = 0;
  const dropOff = Array.from(groups.values())
    .sort((a, b) => a.endsMonth.localeCompare(b.endsMonth))
    .map((g) => {
      freed += g.amount;
      const pct = salary ? Math.round((g.amount / salary) * 1000) / 10 : null;
      return { ...g, freedTotal: freed, pctOfSalary: pct };
    });

  return {
    today: iso(today),
    cycle: {
      start: iso(cycle.start),
      payroll: iso(cycle.payroll),
      leftToPay,
      unpaidCount: unpaid.length,
      lateCount: pay.filter((i) => i.status === STATUS_LATE).length,
      paidCount: pay.length - unpaid.length,
      items: pay,
    },
    commitments: {
      fromCash,
      fromCashMonthly: fromCash.reduce((s, i) => s + i.amount, 0),
      onCards,
    },
    outlook: { committed, dropOff },
    salarySet: !!salary,
    unsetKinds: active.filter((r) => !r.kindSet).length,
    needsAttention: needsAttention(active),
  };
}

module.exports = {
  PAYROLL_DAY,
  payCycle,
  dueDateInCycle,
  chargeDateForStatement,
  buildBillsPage,
};
