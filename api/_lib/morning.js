// Morning money push: what's due today and how much of this week's
// allowance is left per day (the WS4 weekly budget), worked out on the server and sent straight to the phone as a Web
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
const { activeInMonth, monthOf } = require('./bills');
const { budgetLevel, pctText, stealsLines } = require('./alerts');

const JAKARTA_OFFSET_MS = 7 * 60 * 60 * 1000;
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
// active rows only; due day clamped to the month's length; only in months
// between Starts and Ends (activeInMonth in ./bills -- since WS2 this holds
// for bills too, not just installments). Rows come from fetchInstallmentRows(), whose dates are already
// UTC-midnight serial conversions.
function billsDueOn(rows, today) {
  const y = today.getUTCFullYear();
  const m = today.getUTCMonth();
  return rows.filter((r) => {
    if (!r.isActive || !r.dayOfMonth) return false;
    const day = Math.max(1, Math.min(r.dayOfMonth, 31));
    if (!sameDay(clampedDay(y, m, day), today)) return false;
    return activeInMonth(r, monthOf(today));
  });
}

// 'YYYY-MM-DD' -> "2 Dec", from the string so no time zone shifts it.
function shortIso(isoDay) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDay || '');
  return m ? `${Number(m[3])} ${MONTHS_SHORT[Number(m[2]) - 1]}` : '';
}

// { title, body, url } for sw.js, plus `summary` (the same facts as data)
// for the dry-run response.
//
// `week` is computeWeek(...).week from api/_lib/week.js (the WS4 weekly
// budget): this week's variable spending against the weekly allowance plus
// rollover, `left`, `perDay` and `daysLeft` (today included). `left` is
// null when weekly_allowance_rp isn't set in Settings; pass null for `week`
// when it couldn't be worked out at all. Before the Debt Exit work this
// came from the Diary tab's monthly left-to-spend.
//
// WS8 additions:
//   - On the first day of the budget week (week_start_day, Wednesday by
//     default) the title becomes "Allowance ready", with the carry-over
//     from last week spelled out.
//   - `steals`: Steals rows due today (alerts.stealsDueOn), listed after
//     the bills.
//   - `warnPct`: once this week's spending is past it, a "% used" line.
function composeMorning({ bills, week, steals = [], warnPct }) {
  const left = week && week.left !== null && week.left !== undefined ? week.left : null;
  const perDay = left === null ? null : week.perDay;
  const weekStartsToday = Boolean(week && week.today && week.today === week.start);
  const allowanceReady = weekStartsToday && left !== null;

  let title;
  if (left === null) title = 'Good morning';
  else if (allowanceReady) title = `Allowance ready: ${formatRupiah(week.available)} this week`;
  else if (left < 0) title = `Over by ${formatRupiah(left)} this week`;
  else title = `${formatRupiah(perDay)}/day left this week`;

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

  lines.push(...stealsLines(steals, 'today'));

  if (!week) {
    lines.push("Couldn't work out this week's budget.");
  } else if (left === null) {
    lines.push('Set weekly_allowance_rp in Settings to get a daily budget.');
  } else if (allowanceReady) {
    const carry = week.carryIn || 0;
    if (carry > 0) lines.push(`${formatRupiah(week.allowance)} + ${formatRupiah(carry)} carried over`);
    else if (carry < 0) lines.push(`${formatRupiah(week.allowance)} − ${formatRupiah(carry)} overspent last week`);
    if (left >= 0) lines.push(`${formatRupiah(perDay)}/day for ${week.daysLeft} day(s), to ${shortIso(week.end)}`);
  } else if (left >= 0) {
    lines.push(`${formatRupiah(left)} left for ${week.daysLeft} day(s), to ${shortIso(week.end)}`);
  }
  if (!allowanceReady && warnPct !== undefined) {
    const b = budgetLevel(week, warnPct);
    if (b && b.level === 'warn') lines.push(`${pctText(b.used)} of this week's budget used.`);
  }

  return {
    title,
    body: lines.join('\n'),
    url: '/',
    summary: {
      weekStart: week ? week.start : null,
      weekEnd: week ? week.end : null,
      daysLeft: week ? week.daysLeft : null,
      left,
      perDay,
      allowanceReady,
      bills: bills.map((b) => ({ name: b.name, sof: b.sof, amount: b.amount })),
      steals: (steals || []).map((r) => ({ source: r.source, type: r.type, amount: r.amount })),
    },
  };
}

module.exports = {
  jakartaToday,
  billsDueOn,
  composeMorning,
};
