// Credit card statements worked out from `transactions` (Debt Exit plan,
// replacing the Diary tab's card rows).
//
// Every transaction already carries a statement month in its Month column:
//   - a card swipe gets billingMonthForDate(date) -- on or before the 12th
//     counts in that month, after the 12th in the next (see
//     api/_lib/reconcile.js and Reconciliations.gs);
//   - a card payment's card leg (Add Payment / pay-card, or Convert to card
//     payment) gets the statement month it pays, chosen in the form.
// So, for card C and statement month M:
//   charges  = C's rows with Month = M, except Transfer Income legs
//              (swipes, cicilan, fees and interest count; refunds and other
//              non-transfer credits net off; a Transfer *Expense* leg such
//              as a cash advance out of the card is a charge too)
//   payments = C's Transfer Income legs with Month = M
//   amount   = charges, paid = payments
// The statement closes on the 12th of M. Before that it's still "open";
// after it, it's "billed" until payments cover it (paid >= amount - 0.5,
// the project's whole-statement-only rule), then "paid". An amount of 0.5
// or less after closing is "none" (nothing owed, or the card is in credit).
//
// The due date comes from an optional "Statement Due Day" column on
// Accounts (a day of month, typed by hand): the first such day after the
// statement closes. Blank -> no due date and never late.
//
// Rows are fetchTransactionsForReconcile() rows: { sof, month 'YYYY-MM',
// type, amount (Total, Income negative), isTransfer }. Dates are
// UTC-midnight Dates holding Jakarta calendar days, read with getUTC*().
// Nothing here reads or writes the Diary.

const STATEMENT_CLOSE_DAY = 12;
const PAID_TOLERANCE = 0.5;

const STATUS_OPEN = 'open';
const STATUS_BILLED = 'billed';
const STATUS_PAID = 'paid';
const STATUS_NONE = 'none';

function sameAccount(a, b) {
  return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
}

function isCreditCardType(type) {
  return String(type || '').toLowerCase().includes('credit');
}

function utcDay(year, month0, day) {
  return new Date(Date.UTC(year, month0, day));
}

function clampedUtcDay(year, month0, day) {
  const last = new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
  return utcDay(year, month0, Math.min(day, last));
}

function isoDay(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function monthParts(month) {
  const [y, m] = String(month).split('-').map(Number);
  return { y, m0: m - 1 };
}

function shiftMonthKey(month, n) {
  const { y, m0 } = monthParts(month);
  const d = utcDay(y, m0 + n, 1);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function closeDateFor(month) {
  const { y, m0 } = monthParts(month);
  return utcDay(y, m0, STATEMENT_CLOSE_DAY);
}

// First `dueDay` strictly after the statement's close date, or null.
function dueDateFor(month, dueDay) {
  const day = Number(dueDay);
  if (!Number.isInteger(day) || day < 1 || day > 31) return null;
  const { y, m0 } = monthParts(month);
  return day > STATEMENT_CLOSE_DAY ? clampedUtcDay(y, m0, day) : clampedUtcDay(y, m0 + 1, day);
}

// Two decimals, so sums carry no float dust.
function round2(n) {
  return Math.round(n * 100) / 100;
}

// One card's statement for one month. `today` is a Jakarta-day Date.
function statementFor(rows, { card, month, today, dueDay = null }) {
  let charges = 0;
  let payments = 0;
  let chargeCount = 0;
  let paymentCount = 0;
  rows.forEach((r) => {
    if (r.month !== month || !sameAccount(r.sof, card)) return;
    if (r.isTransfer && r.type === 'Income') {
      payments += Math.abs(Number(r.amount) || 0);
      paymentCount += 1;
    } else {
      charges += Number(r.amount) || 0;
      chargeCount += 1;
    }
  });
  const amount = round2(charges);
  const paid = round2(payments);
  const closeDate = closeDateFor(month);
  const dueDate = dueDateFor(month, dueDay);

  let status;
  if (today <= closeDate) status = STATUS_OPEN;
  else if (amount <= PAID_TOLERANCE) status = STATUS_NONE;
  else if (paid >= amount - PAID_TOLERANCE) status = STATUS_PAID;
  else status = STATUS_BILLED;

  return {
    card,
    month,
    amount,
    paid,
    remaining: round2(Math.max(0, amount - paid)),
    status,
    closeDate: isoDay(closeDate),
    dueDate: dueDate ? isoDay(dueDate) : null,
    isLate: status === STATUS_BILLED && !!dueDate && today > dueDate,
    chargeCount,
    paymentCount,
  };
}

// Statements for every credit card in `accounts`, for `months` months
// ending at `toMonth` (newest first).
function statementsFor(rows, accounts, { toMonth, months = 3, today, card = null }) {
  const cards = accounts.filter((a) => isCreditCardType(a.type) && (!card || sameAccount(a.name, card)));
  const out = [];
  cards.forEach((a) => {
    for (let i = 0; i < months; i += 1) {
      out.push(statementFor(rows, { card: a.name, month: shiftMonthKey(toMonth, -i), today, dueDay: a.statementDueDay }));
    }
  });
  return out;
}

module.exports = {
  STATEMENT_CLOSE_DAY,
  STATUS_OPEN,
  STATUS_BILLED,
  STATUS_PAID,
  STATUS_NONE,
  isCreditCardType,
  dueDateFor,
  shiftMonthKey,
  statementFor,
  statementsFor,
};
