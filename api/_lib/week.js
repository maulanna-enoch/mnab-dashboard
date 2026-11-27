// Weekly budget engine (Debt Exit plan, WS4).
//
// Answers "how much variable spending is left this week?" from:
//   - the Settings tab (WS0): weekly_allowance_rp, week_start_day,
//     rollover_enabled, rollover_cap_rp, budget_start_date
//   - classified transactions (WS1): only Kind = Variable counts
//
// Rules:
//   - A week runs from week_start_day (Wednesday by default) to the day
//     before the next one (Wednesday -> Tuesday). "Today" is the calendar
//     date in Jakarta (UTC+7, no DST), never the server's local date.
//   - A transaction counts in the week of its Date -- the day of the swipe
//     for cards, not the statement month. Pending and uncleared rows count.
//   - Proposed email-import duplicates (issue #51): while an imported row
//     and a manual row are waiting for the user to Confirm/Decline the
//     match, both are in the sheet. The imported (Pending) leg is left out
//     so the same purchase isn't counted twice; it's listed in
//     `excluded` so nothing disappears silently.
//   - Rollover (when rollover_enabled): what a week had left carries into
//     the next. A positive carry is capped at rollover_cap_rp (blank = no
//     cap). A negative carry (overspend) reduces the next week, but a week
//     never starts below 0 -- overspend beyond a whole week's allowance is
//     not carried further. With rollover off, every week starts fresh.
//   - The rollover chain starts at budget_start_date's week (carry 0
//     there). If that setting is blank, it starts at the oldest week of the
//     returned history, so carries can shift as that window slides; a
//     warning says so.
//   - The current allowance is applied to every week (the Settings tab
//     keeps no history of past allowances).
//
// Dates are handled as whole day numbers (days since 1970-01-01) built from
// date parts -- never toISOString() on a local Date, which shifts WIB dates
// back a day (see MNAB-project-state.md, "Known bug patterns").
//
// Pure functions only, no Sheets API: the endpoint is
// GET /api/cashflow-summary?action=week (api/cashflow-summary.js).

const JAKARTA_OFFSET_MS = 7 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_HISTORY_WEEKS = 12;
const MAX_HISTORY_WEEKS = 104;

const pad2 = (n) => String(n).padStart(2, '0');

// 'YYYY-MM-DD' -> day number, or null when not a real date.
function dayFromIso(s) {
  const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = Date.UTC(y, mo - 1, d);
  const check = new Date(t);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null;
  return t / DAY_MS;
}

function isoFromDay(day) {
  const d = new Date(day * DAY_MS);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

// A transaction's Date from fetchTransactionRows() is serialToDate(serial):
// a Date at UTC midnight of the sheet's calendar date (plus any time-of-day
// fraction). Its UTC parts ARE the calendar date.
function dayFromSheetDate(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  return Math.floor(date.getTime() / DAY_MS);
}

// Today's calendar date in Jakarta, as a day number.
function jakartaToday(nowMs) {
  return Math.floor(((nowMs === undefined ? Date.now() : nowMs) + JAKARTA_OFFSET_MS) / DAY_MS);
}

// 0 = Sunday ... 6 = Saturday. Day 0 (1970-01-01) was a Thursday.
function weekdayOfDay(day) {
  return (((day + 4) % 7) + 7) % 7;
}

// First day of the budget week containing `day`.
function weekStartFor(day, weekStartIndex) {
  const back = (weekdayOfDay(day) - weekStartIndex + 7) % 7;
  return day - back;
}

// The imported (Pending) leg of a match the user hasn't resolved yet.
function isProposedImportDuplicate(r) {
  return !!(r.isPending && r.matchId && String(r.matchStatus || '').toLowerCase() === 'proposed');
}

// Rows -> the Variable spending lines, each with its day number.
// Returns { lines, excluded, undatedCount }.
function variableLines(rows) {
  const lines = [];
  const excluded = [];
  let undatedCount = 0;
  (rows || []).forEach((r) => {
    if (r.kind !== 'Variable') return;
    const day = r.hasDate === false ? null : dayFromSheetDate(r.date);
    if (day === null) { undatedCount += 1; return; }
    const line = {
      day,
      rowNumber: r.rowNumber,
      date: isoFromDay(day),
      payee: r.payee,
      sof: r.sof,
      amount: Math.round(Number(r.amount) || 0),
      isPending: !!r.isPending,
      isCleared: !!r.isCleared,
      kindRule: r.kindRule || null,
      category: r.category || null,
      categoryGroup: r.categoryGroup || null,
    };
    if (isProposedImportDuplicate(r)) {
      excluded.push({ ...line, reason: 'proposed-duplicate', matchId: r.matchId });
      return;
    }
    lines.push(line);
  });
  return { lines, excluded, undatedCount };
}

function stripDay(line) {
  const { day, ...rest } = line;
  return rest;
}

// settings: the `values` object from parseSettings().
// options: { nowMs, asOf ('YYYY-MM-DD'), historyWeeks, includeTransactions }
function computeWeek(rows, settings, options = {}) {
  const warnings = [];
  const s = settings || {};
  const weekStartIndex = Number.isInteger(s.week_start_index) && s.week_start_index >= 0 ? s.week_start_index : 3;
  const allowance = typeof s.weekly_allowance_rp === 'number' ? s.weekly_allowance_rp : null;
  const rolloverEnabled = s.rollover_enabled !== false;
  const rolloverCap = typeof s.rollover_cap_rp === 'number' ? s.rollover_cap_rp : null;

  let today = jakartaToday(options.nowMs);
  if (options.asOf) {
    const d = dayFromIso(options.asOf);
    if (d === null) throw new Error(`Invalid "date" ${options.asOf} -- expected YYYY-MM-DD`);
    today = d;
  }

  let historyWeeks = Number(options.historyWeeks);
  if (!Number.isInteger(historyWeeks) || historyWeeks < 0) historyWeeks = DEFAULT_HISTORY_WEEKS;
  historyWeeks = Math.min(historyWeeks, MAX_HISTORY_WEEKS);

  const currentStart = weekStartFor(today, weekStartIndex);
  const windowStart = currentStart - historyWeeks * 7;

  let chainStart = windowStart;
  let budgetStart = null;
  if (s.budget_start_date) {
    const d = dayFromIso(s.budget_start_date);
    if (d !== null) {
      budgetStart = weekStartFor(d, weekStartIndex);
      chainStart = budgetStart;
    }
  } else if (rolloverEnabled && allowance !== null) {
    warnings.push('budget_start_date is not set -- rollover is counted from the oldest week shown, so carried amounts can change as weeks pass.');
  }
  if (allowance === null) warnings.push('weekly_allowance_rp is not set -- showing spending only.');

  const { lines, excluded, undatedCount } = variableLines(rows);
  if (undatedCount) warnings.push(`${undatedCount} Variable transaction(s) have no date and aren't counted in any week.`);

  // Spend per week start, over every week the chain or window touches.
  const firstWeek = Math.min(chainStart, windowStart);
  const spentByWeek = new Map();
  const linesByWeek = new Map();
  lines.forEach((l) => {
    const ws = weekStartFor(l.day, weekStartIndex);
    if (ws < firstWeek || ws > currentStart) return;
    spentByWeek.set(ws, (spentByWeek.get(ws) || 0) + l.amount);
    if (!linesByWeek.has(ws)) linesByWeek.set(ws, []);
    linesByWeek.get(ws).push(l);
  });

  const weeks = [];
  let carry = 0;
  for (let ws = firstWeek; ws <= currentStart; ws += 7) {
    const spent = spentByWeek.get(ws) || 0;
    const beforeStart = ws < chainStart;
    const week = {
      start: isoFromDay(ws),
      end: isoFromDay(ws + 6),
      spent,
      transactionCount: (linesByWeek.get(ws) || []).length,
      beforeBudgetStart: beforeStart,
    };
    if (allowance !== null && !beforeStart) {
      const carryIn = rolloverEnabled ? carry : 0;
      const available = Math.max(0, allowance + carryIn);
      const left = available - spent;
      let carryOut = 0;
      if (rolloverEnabled) {
        carryOut = left;
        if (carryOut > 0 && rolloverCap !== null) carryOut = Math.min(carryOut, rolloverCap);
      }
      Object.assign(week, { allowance, carryIn, available, left, carryOut, kept: spent <= available });
      carry = carryOut;
    } else {
      Object.assign(week, { allowance, carryIn: null, available: null, left: null, carryOut: null, kept: null });
    }
    weeks.push(week);
  }

  const current = weeks[weeks.length - 1];
  const daysLeft = currentStart + 6 - today + 1; // today included
  current.today = isoFromDay(today);
  current.daysLeft = daysLeft;
  current.perDay = current.left === null ? null : Math.max(0, Math.floor(current.left / daysLeft));
  // Not settled until the week ends.
  delete current.carryOut;
  delete current.kept;
  const currentLines = (linesByWeek.get(currentStart) || []).slice().sort((a, b) => b.day - a.day || b.rowNumber - a.rowNumber);
  if (options.includeTransactions !== false) current.transactions = currentLines.map(stripDay);

  const history = weeks.filter((w) => {
    const d = dayFromIso(w.start);
    return d >= windowStart && d < currentStart;
  });

  // Consecutive completed weeks (newest first) that stayed within budget.
  let streak = 0;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i].kept !== true) break;
    streak += 1;
  }

  const excludedThisWeek = excluded
    .filter((l) => weekStartFor(l.day, weekStartIndex) === currentStart)
    .map(stripDay);

  return {
    today: isoFromDay(today),
    settings: {
      weekStartDay: s.week_start_day || 'Wednesday',
      weeklyAllowance: allowance,
      rolloverEnabled,
      rolloverCap,
      budgetStartDate: budgetStart === null ? null : isoFromDay(budgetStart),
    },
    week: current,
    history,
    streak,
    excluded: excludedThisWeek,
    warnings,
  };
}

module.exports = {
  computeWeek,
  variableLines,
  weekStartFor,
  weekdayOfDay,
  jakartaToday,
  dayFromIso,
  isoFromDay,
  dayFromSheetDate,
  isProposedImportDuplicate,
  DEFAULT_HISTORY_WEEKS,
  MAX_HISTORY_WEEKS,
};
