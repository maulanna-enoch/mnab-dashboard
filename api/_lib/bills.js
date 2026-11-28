// Bills registry helpers (Debt Exit plan WS2).
//
// `installmentsbills` is the one registry for everything committed each
// month: cash bills, bills charged to a card, and installments (cicilan).
// Rows come from fetchInstallmentRows() in ./sheets.js.
//
// Kind (self-provisioned column on installmentsbills, read by header name):
//   Cash bill    paid from a cash account each month
//   Card bill    charged to a credit card each month (subscriptions etc.)
//   Installment  a fixed number of monthly payments, Starts..Ends
// A blank Kind falls back to the old convention: Ends in year 2099 or later
// means an open-ended bill ("Bill"), anything else is an Installment.
//
// Starts / Ends are honoured for every kind, not just installments, so a
// bill that stops (Ends = its last month) or a price increase entered as
// its own row with a later Starts only counts in the months it covers.
// A blank Starts means "since forever"; a blank Ends, or one in 2099+,
// means "no end". An installment still needs both to count.
//
// Months are 'YYYY-MM' strings, compared as strings. Every date here is a
// UTC-midnight Date from serialToDate(), read with getUTC*() only.
//
// Keep KIND_* and the fallback in step with apps-script/InstallmentsBills.gs.

const BILL_YEAR_THRESHOLD = 2099;

const KIND_CASH_BILL = 'Cash bill';
const KIND_CARD_BILL = 'Card bill';
const KIND_INSTALLMENT = 'Installment';
const KIND_BILL = 'Bill'; // fallback for an open-ended row with no Kind set
const BILL_KINDS = [KIND_CASH_BILL, KIND_CARD_BILL, KIND_INSTALLMENT];

const MONTH_RE = /^(\d{4})-(\d{2})$/;

// Canonical Kind for a raw cell value, or null when blank / unrecognised.
// Forgiving about case, spaces and a trailing "s" ("cash bills").
function normalizeBillKind(raw) {
  const s = String(raw || '').trim().toLowerCase().replace(/\s+/g, ' ').replace(/s$/, '');
  if (!s) return null;
  if (s === 'cash bill' || s === 'cash') return KIND_CASH_BILL;
  if (s === 'card bill' || s === 'card') return KIND_CARD_BILL;
  if (s === 'installment' || s === 'instalment' || s === 'cicilan') return KIND_INSTALLMENT;
  return null;
}

function isOpenEndDate(date) {
  return !date || date.getUTCFullYear() >= BILL_YEAR_THRESHOLD;
}

// { kind, kindSet, isBill } for a row's raw Kind cell and Ends date.
function resolveKind(rawKind, endDate) {
  const explicit = normalizeBillKind(rawKind);
  if (explicit) return { kind: explicit, kindSet: true, isBill: explicit !== KIND_INSTALLMENT };
  const openEnded = !!endDate && endDate.getUTCFullYear() >= BILL_YEAR_THRESHOLD;
  return openEnded
    ? { kind: KIND_BILL, kindSet: false, isBill: true }
    : { kind: KIND_INSTALLMENT, kindSet: false, isBill: false };
}

function monthOf(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function parseMonth(text) {
  const m = MONTH_RE.exec(String(text || '').trim());
  if (!m) return null;
  const mm = Number(m[2]);
  return mm >= 1 && mm <= 12 ? `${m[1]}-${m[2]}` : null;
}

// This calendar month in Jakarta (UTC+7), as 'YYYY-MM'. Vercel runs in UTC.
function currentJakartaMonth(now = new Date()) {
  return monthOf(new Date(now.getTime() + 7 * 60 * 60 * 1000));
}

function addMonths(month, n) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return monthOf(d);
}

// Calendar months from Starts through Ends, inclusive. Null when either is
// missing or the row is open-ended.
function totalMonths(row) {
  if (!row.startDate || isOpenEndDate(row.endDate)) return null;
  const n = (row.endDate.getUTCFullYear() - row.startDate.getUTCFullYear()) * 12
    + (row.endDate.getUTCMonth() - row.startDate.getUTCMonth()) + 1;
  return n > 0 ? n : null;
}

// Which payment (1-based) `month` is for an installment, or null.
function installmentNumber(row, month) {
  if (!row.startDate) return null;
  const [y, m] = month.split('-').map(Number);
  const n = (y - row.startDate.getUTCFullYear()) * 12 + (m - 1 - row.startDate.getUTCMonth()) + 1;
  return n > 0 ? n : null;
}

// Is `month` ('YYYY-MM') inside this row's Starts..Ends, whatever is_active
// says? Used to keep a switched-off row on the statements it was actually
// charged to (api/_lib/bills-page.js).
function inDateRange(row, month) {
  if (!row.isBill && (!row.startDate || !row.endDate)) return false;
  if (row.startDate && month < monthOf(row.startDate)) return false;
  if (!isOpenEndDate(row.endDate) && month > monthOf(row.endDate)) return false;
  return true;
}

// Does this row commit money in `month` ('YYYY-MM')? is_active FALSE means
// the row is switched off for every month, past or future.
function activeInMonth(row, month) {
  return !!row.isActive && inDateRange(row, month);
}

function kindBucket(kind) {
  if (kind === KIND_CASH_BILL) return 'cashBill';
  if (kind === KIND_CARD_BILL) return 'cardBill';
  if (kind === KIND_INSTALLMENT) return 'installment';
  return 'bill';
}

// What's committed in `month`: every active row, totals overall and per
// Kind, and the rows themselves.
function committedInMonth(rows, month) {
  const byKind = { cashBill: 0, cardBill: 0, bill: 0, installment: 0 };
  const items = [];
  let total = 0;
  rows.forEach((r) => {
    if (!activeInMonth(r, month)) return;
    total += r.amount;
    byKind[kindBucket(r.kind)] += r.amount;
    const item = { id: r.id, name: r.name, kind: r.kind, sof: r.sof, amount: r.amount, dayOfMonth: r.dayOfMonth };
    if (r.kind === KIND_INSTALLMENT) {
      item.installment = installmentNumber(r, month);
      item.totalMonths = totalMonths(r);
    }
    if (!isOpenEndDate(r.endDate)) item.endsMonth = monthOf(r.endDate);
    items.push(item);
  });
  return { month, total, byKind, count: items.length, items };
}

module.exports = {
  BILL_YEAR_THRESHOLD,
  BILL_KINDS,
  KIND_CASH_BILL,
  KIND_CARD_BILL,
  KIND_INSTALLMENT,
  KIND_BILL,
  normalizeBillKind,
  resolveKind,
  isOpenEndDate,
  monthOf,
  parseMonth,
  currentJakartaMonth,
  addMonths,
  totalMonths,
  installmentNumber,
  inDateRange,
  activeInMonth,
  committedInMonth,
};
