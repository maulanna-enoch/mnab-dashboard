// "Where it went" (Debt Exit plan WS8): Variable spending by category and
// payee for one week or one calendar month.
//
// Uses the same lines as the weekly budget (api/_lib/week.js,
// variableLines): Kind = Variable only, counted on the swipe date, pending
// and uncleared rows included, proposed import duplicates left out. Each
// line carries the category classifyTransactionCategory() gave its row
// (api/_lib/categories.js); a Variable row nothing matched is
// "Uncategorised".
//
// Periods:
//   week   week_start_day .. the day before the next one (Wed..Tue default)
//   month  the calendar month of the swipe date
// offset 0 is the period containing "today" (Jakarta), -1 the one before…
//
// Comparison: a finished period is compared with the whole period before
// it. The current, unfinished one is compared with the same number of days
// at the start of the period before ("vs same point last week"), so a
// Wednesday morning isn't measured against a whole week.
//
// Allowance: weekly_allowance_rp for a week; for a month the weekly
// allowance × days in the month / 7. Null when it isn't set.
//
// Pure functions only; the endpoint is
// GET /api/cashflow-summary?action=where (api/cashflow-summary.js).

const { variableLines, weekStartFor, jakartaToday, dayFromIso, isoFromDay } = require('./week');

const UNCATEGORISED = 'Uncategorised';
const DEFAULT_TOP_PAYEES = 10;
const HISTORY_PERIODS = 12;
const MAX_OFFSET = 520;

// Day number -> {y, m (1-12)} from its ISO date, so no local-time Date.
function ymOfDay(day) {
  const iso = isoFromDay(day);
  return { y: Number(iso.slice(0, 4)), m: Number(iso.slice(5, 7)) };
}
function monthStartDay(y, m) {
  return dayFromIso(`${y}-${String(m).padStart(2, '0')}-01`);
}
function addMonths(y, m, n) {
  const idx = y * 12 + (m - 1) + n;
  return { y: Math.floor(idx / 12), m: (idx % 12) + 1 };
}

// [start, end] day numbers of the period `offset` periods from the one
// containing `today`.
function periodBounds(period, today, offset, weekStartIndex) {
  if (period === 'month') {
    const { y, m } = ymOfDay(today);
    const a = addMonths(y, m, offset);
    const b = addMonths(a.y, a.m, 1);
    const start = monthStartDay(a.y, a.m);
    return { start, end: monthStartDay(b.y, b.m) - 1 };
  }
  const start = weekStartFor(today, weekStartIndex) + offset * 7;
  return { start, end: start + 6 };
}

function lineCategory(l) {
  return l.category || UNCATEGORISED;
}

// Lines -> [{name, group, amount, count}] by category, biggest first,
// Uncategorised last whatever its size (it's a to-do, not a category).
function byCategory(lines) {
  const map = new Map();
  lines.forEach((l) => {
    const name = lineCategory(l);
    const c = map.get(name) || { name, group: l.category ? (l.categoryGroup || null) : null, amount: 0, count: 0 };
    c.amount += l.amount;
    c.count += 1;
    map.set(name, c);
  });
  return Array.from(map.values()).sort((a, b) => {
    if ((a.name === UNCATEGORISED) !== (b.name === UNCATEGORISED)) return a.name === UNCATEGORISED ? 1 : -1;
    return b.amount - a.amount || a.name.localeCompare(b.name);
  });
}

// Lines -> [{name, amount, count, category}] by payee, biggest first. A
// payee's category is the one most of its spending here went to.
function byPayee(lines) {
  const map = new Map();
  lines.forEach((l) => {
    const name = String(l.payee || '').trim() || '(no payee)';
    const key = name.toLowerCase();
    const p = map.get(key) || { name, amount: 0, count: 0, cats: new Map() };
    p.amount += l.amount;
    p.count += 1;
    const cat = lineCategory(l);
    p.cats.set(cat, (p.cats.get(cat) || 0) + l.amount);
    map.set(key, p);
  });
  return Array.from(map.values())
    .map((p) => {
      let category = null;
      let best = -Infinity;
      p.cats.forEach((amt, cat) => { if (amt > best) { best = amt; category = cat; } });
      return { name: p.name, amount: p.amount, count: p.count, category };
    })
    .sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name));
}

function sum(lines) {
  return lines.reduce((s, l) => s + l.amount, 0);
}

// Short per-category summary for one set of lines: what the Home card
// shows. Every category, so the bar adds up.
function summariseByCategory(lines) {
  return byCategory(lines).map((c) => ({ name: c.name, group: c.group, amount: c.amount, count: c.count }));
}

// rows: classified transaction rows (fetchClassifiedTransactionRows).
// settings: parseSettings() values.
// options: { period: 'week'|'month', offset (<= 0), asOf 'YYYY-MM-DD',
//            nowMs, category, topPayees }
function computeWhere(rows, settings, options = {}) {
  const s = settings || {};
  const warnings = [];
  const period = options.period === 'month' ? 'month' : 'week';
  const weekStartIndex = Number.isInteger(s.week_start_index) && s.week_start_index >= 0 ? s.week_start_index : 3;
  const weekly = typeof s.weekly_allowance_rp === 'number' ? s.weekly_allowance_rp : null;

  let offset = options.offset === undefined ? 0 : Number(options.offset);
  if (!Number.isInteger(offset) || offset > 0 || offset < -MAX_OFFSET) {
    throw new Error(`Invalid "offset" ${options.offset} -- expected a whole number from -${MAX_OFFSET} to 0`);
  }

  let today = jakartaToday(options.nowMs);
  if (options.asOf) {
    const d = dayFromIso(options.asOf);
    if (d === null) throw new Error(`Invalid "date" ${options.asOf} -- expected YYYY-MM-DD`);
    today = d;
  }

  const { lines: all, excluded, undatedCount } = variableLines(rows);
  if (undatedCount) warnings.push(`${undatedCount} Variable transaction(s) have no date and aren't counted.`);

  const cur = periodBounds(period, today, offset, weekStartIndex);
  const prev = periodBounds(period, today, offset - 1, weekStartIndex);
  const inProgress = today >= cur.start && today <= cur.end;
  const daysTotal = cur.end - cur.start + 1;
  const daysElapsed = inProgress ? today - cur.start + 1 : daysTotal;
  // Unfinished period: compare with the same number of days of the last one.
  const prevEnd = inProgress ? Math.min(prev.end, prev.start + daysElapsed - 1) : prev.end;

  const inRange = (a, b) => (l) => l.day >= a && l.day <= b;
  const lines = all.filter(inRange(cur.start, cur.end));
  const prevLines = all.filter(inRange(prev.start, prevEnd));

  const prevByCat = new Map(byCategory(prevLines).map((c) => [c.name, c.amount]));
  const categories = byCategory(lines).map((c) => ({ ...c, compareAmount: prevByCat.get(c.name) || 0 }));

  const payeesAll = byPayee(lines);
  let top = Number(options.topPayees);
  if (!Number.isInteger(top) || top < 1) top = DEFAULT_TOP_PAYEES;
  const rest = payeesAll.slice(top);

  let allowance = null;
  if (weekly !== null) allowance = period === 'week' ? weekly : Math.round((weekly * daysTotal) / 7);

  const out = {
    period,
    offset,
    today: isoFromDay(today),
    start: isoFromDay(cur.start),
    end: isoFromDay(cur.end),
    inProgress,
    daysElapsed,
    daysTotal,
    total: sum(lines),
    count: lines.length,
    compare: {
      start: isoFromDay(prev.start),
      end: isoFromDay(prevEnd),
      total: sum(prevLines),
      partial: inProgress,
    },
    allowance,
    categories,
    payees: payeesAll.slice(0, top),
    morePayees: { count: rest.length, amount: sum(rest) },
    excludedCount: excluded.filter(inRange(cur.start, cur.end)).length,
    warnings,
  };

  if (options.category) {
    const want = String(options.category).trim().toLowerCase();
    const match = (l) => lineCategory(l).toLowerCase() === want;
    const mine = lines.filter(match);
    const history = [];
    for (let i = HISTORY_PERIODS - 1; i >= 0; i -= 1) {
      const b = periodBounds(period, today, offset - i, weekStartIndex);
      const amt = sum(all.filter((l) => l.day >= b.start && l.day <= b.end && match(l)));
      history.push({ start: isoFromDay(b.start), end: isoFromDay(b.end), amount: amt, current: i === 0 });
    }
    const found = categories.find((c) => c.name.toLowerCase() === want);
    out.detail = {
      name: found ? found.name : String(options.category).trim(),
      group: found ? found.group : null,
      amount: sum(mine),
      count: mine.length,
      compareAmount: found ? found.compareAmount : sum(prevLines.filter(match)),
      history,
      payees: byPayee(mine).map(({ category, ...p }) => p),
      transactions: mine
        .slice()
        .sort((a, b) => b.day - a.day || b.rowNumber - a.rowNumber)
        .map(({ day, ...l }) => l),
    };
  }
  return out;
}

module.exports = {
  computeWhere,
  summariseByCategory,
  byCategory,
  byPayee,
  periodBounds,
  UNCATEGORISED,
};
