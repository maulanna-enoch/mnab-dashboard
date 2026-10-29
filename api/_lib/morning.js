// Morning money push: what's due today and how much is left to spend per
// day, worked out on the server and sent straight to the phone as a Web
// Push notification. Nothing leaves MNAB's own stack (Vercel + the Sheet).
//
// Used by api/push.js action=morning, which a Vercel cron calls once a day
// (see "crons" in vercel.json).
//
// All dates here are *Jakarta calendar days* held in UTC-midnight Date
// objects, read with getUTC*() only. Vercel runs in UTC, so "today" has to
// be shifted to WIB (UTC+7) before it's taken -- and never formatted with
// toISOString() on a local-time Date (see the timezone gotcha in the
// project docs).
const { formatRupiah } = require('./push');

const JAKARTA_OFFSET_MS = 7 * 60 * 60 * 1000;
const PAYROLL_DAY = 25; // same as PAYROLL_DAY in public/index.html
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MAX_BILL_LINES = 4;
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function utcDay(year, month, day) {
  return new Date(Date.UTC(year, month, day));
}

// Today's date in Jakarta, as a UTC-midnight Date.
function jakartaToday(now = new Date()) {
  const j = new Date(now.getTime() + JAKARTA_OFFSET_MS);
  return utcDay(j.getUTCFullYear(), j.getUTCMonth(), j.getUTCDate());
}

// Same as clampedDate() in apps-script/InstallmentsBills.gs: a due day of 31
// lands on the month's last day in shorter months.
function clampedDay(year, month, day) {
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return utcDay(year, month, Math.min(day, daysInMonth));
}

function sameDay(a, b) {
  return a.getTime() === b.getTime();
}

// Bills and installments due on `today`. Mirrors the rules
// InstallmentsBills.gs uses when it copies rows into `transactions`:
// active rows only; due day clamped to the month's length; an installment
// (Ends before year 2099) only between the month it Starts and the month it
// Ends. Rows come from fetchInstallmentRows(), whose dates are already
// UTC-midnight serial conversions.
function billsDueOn(rows, today) {
  const y = today.getUTCFullYear();
  const m = today.getUTCMonth();
  return rows.filter((r) => {
    if (!r.isActive || !r.dayOfMonth) return false;
    const day = Math.max(1, Math.min(r.dayOfMonth, 31));
    if (!sameDay(clampedDay(y, m, day), today)) return false;
    if (r.isBill) return true;
    if (!r.startDate || !r.endDate) return false;
    const from = utcDay(r.startDate.getUTCFullYear(), r.startDate.getUTCMonth(), 1);
    const to = utcDay(r.endDate.getUTCFullYear(), r.endDate.getUTCMonth() + 1, 0);
    return today >= from && today <= to;
  });
}

// The budget month today falls in. Pay lands on the 25th and a cycle is
// named after the month it starts in (the cash-account rule in the project
// docs): 1st-24th -> last month, 25th onward -> this month.
function cycleFor(today) {
  const y = today.getUTCFullYear();
  const m = today.getUTCMonth();
  const start = today.getUTCDate() >= PAYROLL_DAY ? utcDay(y, m, 1) : utcDay(y, m - 1, 1);
  const month = `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, '0')}`;
  const payroll = utcDay(start.getUTCFullYear(), start.getUTCMonth() + 1, PAYROLL_DAY);
  const days = Math.max(1, Math.round((payroll - today) / MS_PER_DAY));
  return { month, payroll, days };
}

// Same sum as api/cashflow-summary.js: the month's Diary income minus
// everything Paid, Billed or Unbilled. Returns null when Diary has no rows
// for that month yet.
function leftToSpendFor(diaryRows, month) {
  const rows = diaryRows.filter((r) => r.month === month);
  if (rows.length === 0) return null;
  const income = rows.filter((r) => r.type === 'Income').reduce((s, r) => s + r.amount, 0);
  const outflow = rows.filter((r) => r.type === 'Expense').reduce((s, r) => s + r.amount, 0);
  return income - outflow;
}

function shortDate(d) {
  return `${d.getUTCDate()} ${MONTHS_SHORT[d.getUTCMonth()]}`;
}

// { title, body, url } for sw.js, plus `summary` (the same facts as data)
// for the dry-run response.
function composeMorning({ bills, leftToSpend, cycle }) {
  const perDay = leftToSpend === null ? null : Math.max(0, Math.round(leftToSpend / cycle.days));

  let title;
  if (leftToSpend === null) title = 'Good morning';
  else if (leftToSpend < 0) title = `Over by ${formatRupiah(leftToSpend)} this month`;
  else title = `${formatRupiah(perDay)}/day left`;

  const lines = [];
  if (bills.length === 0) {
    lines.push('No bills or installments due today.');
  } else {
    const total = bills.reduce((s, b) => s + b.amount, 0);
    lines.push(bills.length === 1
      ? `Due today: ${formatRupiah(total)}`
      : `${bills.length} due today · ${formatRupiah(total)}`);
    bills.slice(0, MAX_BILL_LINES).forEach((b) => {
      lines.push([`${b.name} ${formatRupiah(b.amount)}`, b.sof].filter(Boolean).join(' · '));
    });
    if (bills.length > MAX_BILL_LINES) lines.push(`+${bills.length - MAX_BILL_LINES} more`);
  }

  if (leftToSpend === null) {
    lines.push(`No Diary rows for ${cycle.month} yet, so no daily budget.`);
  } else if (leftToSpend >= 0) {
    lines.push(`${formatRupiah(leftToSpend)} over ${cycle.days} day(s) to ${shortDate(cycle.payroll)}`);
  }

  return {
    title,
    body: lines.join('\n'),
    url: '/',
    summary: {
      cycleMonth: cycle.month,
      payroll: shortDate(cycle.payroll),
      days: cycle.days,
      leftToSpend,
      perDay,
      bills: bills.map((b) => ({ name: b.name, sof: b.sof, amount: b.amount })),
    },
  };
}

module.exports = {
  jakartaToday,
  billsDueOn,
  cycleFor,
  leftToSpendFor,
  composeMorning,
};
