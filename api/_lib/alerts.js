// Debt Exit WS8: the push notifications beyond the morning money push.
//
//   - Budget warnings: once this week's Variable spending passes
//     push_budget_warn_pct of what's available (70% by default), and again
//     once it goes over. Checked whenever spending can change -- after an
//     email import (api/push.js action=notify) and after a save in the
//     dashboard (action=budget-check) -- and sent at most once per week each,
//     tracked in the PushLog tab (./push-log.js). If spending drops back
//     below a level that already fired (a bill payment matched to its bill,
//     a row re-kinded as Fixed), that level's log entry is cleared so it can
//     fire again this week -- see budgetKeysToClear().
//   - Evening reminder: bills and installments due tomorrow, plus Steals
//     rows whose Due Date is tomorrow (a loan to roll over or repay). Sent
//     by the evening cron only when there's something to say.
//   - Steals due today also go into the morning push (./morning.js).
//
// "Allowance ready" on the first day of the budget week is a variant of the
// morning push itself, so it lives in ./morning.js.
//
// Pure functions only (no Sheets API, no sending), so they can be tested in
// Node without credentials. Dates are Jakarta calendar days: 'YYYY-MM-DD'
// strings, or UTC-midnight Date objects read with getUTC*() only.

const { formatRupiah } = require('./push');

const MAX_LINES = 4;
const DEFAULT_WARN_PCT = 0.7;
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const pad2 = (n) => String(n).padStart(2, '0');

function isoOf(date) {
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

function addDays(date, n) {
  return new Date(date.getTime() + n * 24 * 60 * 60 * 1000);
}

// 'YYYY-MM-DD' -> "2 Dec".
function shortIso(isoDay) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDay || '');
  return m ? `${Number(m[3])} ${MONTHS_SHORT[Number(m[2]) - 1]}` : '';
}

function warnPctFrom(settings) {
  const v = settings && settings.push_budget_warn_pct;
  return typeof v === 'number' && v > 0 && v < 1 ? v : DEFAULT_WARN_PCT;
}

// ── Weekly budget ─────────────────────────────────────────────────────

// week: computeWeek(...).week from ./week.js. Returns null when there's no
// allowance set, otherwise:
//   { level: 'ok' | 'warn' | 'over', used (0..n, fraction of available),
//     spent, available, left, warnPct }
// 'over' means spending is past what's available (left < 0). Spending
// exactly all of it is 'warn', not 'over'. A week that starts at 0 (last
// week's overspend ate it) is 'over' as soon as anything is spent.
function budgetLevel(week, warnPct = DEFAULT_WARN_PCT) {
  if (!week || week.left === null || week.left === undefined || week.available === null || week.available === undefined) return null;
  const { spent, available, left } = week;
  let used;
  if (available > 0) used = spent / available;
  else used = spent > 0 ? Infinity : 0;
  let level = 'ok';
  if (left < 0) level = 'over';
  else if (used >= warnPct) level = 'warn';
  return { level, used, spent, available, left, warnPct };
}

function pctText(fraction) {
  if (!Number.isFinite(fraction)) return '100%+';
  return `${Math.floor(fraction * 100)}%`;
}

// The dedupe keys for this week. Both levels are per week start, so a new
// week starts fresh.
function budgetKeys(week) {
  return { warn: `budget-warn:${week.start}`, over: `budget-over:${week.start}` };
}

// Decides which budget notification (if any) to send now.
//   week        computeWeek(...).week
//   settings    parseSettings(...).values
//   sentKeys    Set from push-log.fetchSentKeys()
// Returns null, or { payload: { title, body, url }, markKeys: [{ key, title }] }.
// When spending jumps straight past 100%, only the "over" message goes out,
// but the warn key is marked too, so the 70% message never arrives late.
function budgetNotification(week, settings, sentKeys) {
  const warnPct = warnPctFrom(settings);
  const b = budgetLevel(week, warnPct);
  if (!b || b.level === 'ok') return null;
  const keys = budgetKeys(week);
  const sent = sentKeys || new Set();
  const rolloverOn = !settings || settings.rollover_enabled !== false;

  if (b.level === 'over') {
    if (sent.has(keys.over)) return null;
    const title = `Over this week's budget by ${formatRupiah(b.left)}`;
    const lines = [`Spent ${formatRupiah(b.spent)} of ${formatRupiah(b.available)} (Variable only).`];
    if (rolloverOn) lines.push("Next week's allowance starts lower by the overspend.");
    lines.push(`Week ends ${shortIso(week.end)}.`);
    const markKeys = [{ key: keys.over, title }];
    if (!sent.has(keys.warn)) markKeys.push({ key: keys.warn, title: '(skipped: went straight over)' });
    return { payload: { title, body: lines.join('\n'), url: '/' }, markKeys };
  }

  if (sent.has(keys.warn) || sent.has(keys.over)) return null;
  const title = `${pctText(b.used)} of this week's budget used`;
  const days = week.daysLeft;
  const lines = [
    `${formatRupiah(b.left)} left for ${days} day(s), to ${shortIso(week.end)}`,
    `That's ${formatRupiah(week.perDay)}/day from here.`,
  ];
  return { payload: { title, body: lines.join('\n'), url: '/' }, markKeys: [{ key: keys.warn, title }] };
}

// Logged keys for this week whose level no longer holds, so they should be
// cleared to let that alert fire again. Spending only goes back down when
// something is corrected -- a bill payment imported as Variable and then
// matched to its bill, a row re-kinded, a delete -- so an alert that fired
// on a wrong number is re-armed for the real one.
//   over logged, now warn or ok  -> clear over
//   warn logged, now ok          -> clear warn (also the "skipped" warn
//                                   entry an over push writes)
// Returns an array of keys (possibly empty).
function budgetKeysToClear(week, settings, sentKeys) {
  const b = budgetLevel(week, warnPctFrom(settings));
  if (!b) return [];
  const keys = budgetKeys(week);
  const sent = sentKeys || new Set();
  const clear = [];
  if (b.level !== 'over' && sent.has(keys.over)) clear.push(keys.over);
  if (b.level === 'ok' && sent.has(keys.warn)) clear.push(keys.warn);
  return clear;
}

// ── Steals due dates ──────────────────────────────────────────────────

// Steal rows (fetchStealsRows(), with the optional Due Date column read
// into `dueDate`) due on `isoDay`. Paybacks are never reminders. A Steals
// row isn't linked to the Payback that settles it, so clearing the Due Date
// (or moving it to the next rollover) is how a row stops reminding.
function stealsDueOn(rows, isoDay) {
  return (rows || []).filter((r) => r.dueDate === isoDay && String(r.direction || '').trim().toLowerCase() === 'steal');
}

function stealLine(r) {
  const what = r.source || r.type || 'Steal';
  return `${what} ${formatRupiah(r.amount)}`;
}

// Lines for the morning push ("today") or the evening one ("tomorrow").
function stealsLines(steals, when) {
  if (!steals || steals.length === 0) return [];
  const total = steals.reduce((s, r) => s + (Number(r.amount) || 0), 0);
  const lines = [steals.length === 1
    ? `Steals due ${when}: ${stealLine(steals[0])}`
    : `${steals.length} Steals due ${when} · ${formatRupiah(total)}`];
  if (steals.length > 1) {
    steals.slice(0, MAX_LINES).forEach((r) => lines.push(stealLine(r)));
    if (steals.length > MAX_LINES) lines.push(`+${steals.length - MAX_LINES} more`);
  }
  return lines;
}

// ── Evening reminder ──────────────────────────────────────────────────

// bills: billsDueOn(installmentRows, tomorrow) from ./morning.js
// steals: stealsDueOn(stealsRows, tomorrowIso)
// Returns null when there's nothing due tomorrow (no push is sent), else
// { title, body, url, summary }.
function composeEvening({ bills, steals, tomorrow }) {
  const b = bills || [];
  const s = steals || [];
  if (b.length === 0 && s.length === 0) return null;

  const billTotal = b.reduce((sum, x) => sum + x.amount, 0);
  const stealTotal = s.reduce((sum, x) => sum + (Number(x.amount) || 0), 0);
  const count = b.length + s.length;

  let title;
  if (count === 1 && b.length === 1) title = `Due tomorrow: ${b[0].name} ${formatRupiah(b[0].amount)}`;
  else if (count === 1) title = `Steals due tomorrow: ${stealLine(s[0])}`;
  else title = `${count} due tomorrow · ${formatRupiah(billTotal + stealTotal)}`;

  const lines = [];
  if (b.length > 0 && count > 1) {
    b.slice(0, MAX_LINES).forEach((x) => lines.push([`${x.name} ${formatRupiah(x.amount)}`, x.sof].filter(Boolean).join(' · ')));
    if (b.length > MAX_LINES) lines.push(`+${b.length - MAX_LINES} more bill(s)`);
  } else if (b.length === 1 && b[0].sof) {
    lines.push(`From ${b[0].sof}`);
  }
  if (s.length > 0 && count > 1) lines.push(...stealsLines(s, 'tomorrow'));
  else if (s.length === 1) lines.push('Roll it over or pay it back.');

  return {
    title,
    body: lines.join('\n'),
    url: b.length > 0 ? '/installments' : '/',
    summary: {
      date: tomorrow ? isoOf(tomorrow) : null,
      bills: b.map((x) => ({ name: x.name, sof: x.sof, amount: x.amount })),
      steals: s.map((x) => ({ source: x.source, type: x.type, amount: x.amount })),
    },
  };
}

module.exports = {
  DEFAULT_WARN_PCT,
  warnPctFrom,
  budgetLevel,
  budgetKeys,
  budgetNotification,
  budgetKeysToClear,
  stealsDueOn,
  stealsLines,
  composeEvening,
  isoOf,
  addDays,
  pctText,
};
