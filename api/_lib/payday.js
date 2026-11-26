// Payday screen (Debt Exit plan, WS8): how this pay period's salary splits.
//
// For the pay period running from the latest payday up to the next one:
//
//   in   salary (+ any extra income: THR, bonus, other Income rows)
//   out  bills due before next payroll     (one summary row)
//        card statements due this cycle    (one summary row)
//        Steals paybacks, per source       (itemised)
//        weekly allowances                 (itemised by week)
//   left = in - out. Negative = "to re-borrow", and the hole goes from
//        the actual hole (Steals log) to hole - principal paid back + the
//        amount re-borrowed.
//
// ---- The pay period ------------------------------------------------------
//
// Nominal payday = payday_day_of_month (Settings, default 25; clamped to
// the month's length). Payroll can land early when that day is a weekend
// or a holiday, so the real start is the date of the salary transaction
// when one is found within PAYDAY_WINDOW_DAYS of the nominal day; otherwise
// the nominal day (period.startSource says which). The period ends the
// day before the NEXT nominal payday (an early credit next month isn't
// known until it happens).
//
// The salary transaction: Kind = Income (not a transfer, not on a credit
// card -- refunds and cashback land there), in that window. Rows with
// Category = Salary win (several are summed, e.g. a split payroll). Failing
// that, the largest Income row of at least half of monthly_salary_rp (any
// size when that setting is blank). None -> monthly_salary_rp is used as
// the expected salary and the page says so.
//
// ---- Bills and card statements ---------------------------------------------
//
// Reuses the Bills page's own cycle (api/_lib/bills-page.js, WS3) so the
// two summary rows always match what /installments/ lists: cash bills due
// in the cycle, and card statements due in it (worked out from
// transactions, api/_lib/statements.js -- the Diary is gone). Amounts are
// the full amounts, paid or not: they're all paid out of this salary.
// That cycle runs from the 25th (PAYROLL_DAY there), so when
// payday_day_of_month is set to another day a warning says the two
// disagree.
//
// ---- Steals paybacks ---------------------------------------------------------
//
// From the Steals log, reserve types only (the same rule and RESERVE_TYPES
// as the actual hole in api/_lib/debt.js), grouped by Source: owed = steals
// - paybacks. Fee = owed * hole_fee_pct (per 30 days, the same rate the
// projection charges on the whole hole). Rollover date = the Due Date of
// that source's steal rows: the earliest one on or after today, else the
// latest one. The log's own Fee column (what a steal cost when it was
// taken) isn't read: fetchStealsRows() doesn't return it.
//
// ---- Weekly allowances -------------------------------------------------------
//
// weekly_allowance_rp * the number of allowance weeks that START inside the
// period (week_start_day, default Wednesday). Usually 4; 5 when the period
// holds five week-start days. A week that started before payday belongs
// to the previous period.
//
// Dates: whole day numbers built from date parts (api/_lib/week.js); never
// toISOString() on a local Date. Pure: no Sheets API. The endpoint is
// GET /api/cashflow-summary?action=payday (handlePayday below).

const {
  weekStartFor,
  jakartaToday,
  dayFromIso,
  isoFromDay,
  dayFromSheetDate,
  isProposedImportDuplicate,
} = require('./week');
const { isReserveType, actualHole } = require('./debt');
const { buildBillsPage, PAYROLL_DAY } = require('./bills-page');
const { isCreditCardType } = require('./statements');

const DEFAULT_PAYDAY = 25;
const PAYDAY_WINDOW_DAYS = 7;
const USUAL_WEEKS = 4;
const SALARY_CATEGORY = 'salary';
const MIN_SALARY_SHARE = 0.5;
const DAY_MS = 24 * 60 * 60 * 1000;

const round = (n) => (typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : n);
const pctOf = (n, base) => (base ? Math.round((n / base) * 1000) / 10 : null);
const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

// Day number of `dayOfMonth` in month (y, m0), clamped to the month length.
function nominalPayday(y, m0, dayOfMonth) {
  const first = new Date(Date.UTC(y, m0, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(dayOfMonth, last)) / DAY_MS;
}

function ymOfDay(day) {
  const d = new Date(day * DAY_MS);
  return { y: d.getUTCFullYear(), m0: d.getUTCMonth() };
}

// Rows -> Income-kind lines that can be pay: not a transfer, not on a card.
function incomeLines(rows, cardNames) {
  const out = [];
  (rows || []).forEach((r) => {
    if (r.kind !== 'Income' || r.isTransfer || r.type !== 'Income') return;
    if (cardNames.has(norm(r.sof))) return;
    if (isProposedImportDuplicate(r)) return;
    const day = r.hasDate === false ? null : dayFromSheetDate(r.date);
    if (day === null) return;
    out.push({
      day,
      rowNumber: r.rowNumber,
      date: isoFromDay(day),
      payee: r.payee,
      sof: r.sof,
      amount: Math.round(Number(r.amount) || 0),
      category: r.category || null,
      isPending: !!r.isPending,
    });
  });
  return out;
}

// The salary line(s) in [from, to], or null.
function findSalary(lines, from, to, expected) {
  const inWindow = lines.filter((l) => l.day >= from && l.day <= to && l.amount > 0);
  const tagged = inWindow.filter((l) => norm(l.category) === SALARY_CATEGORY);
  if (tagged.length) return { lines: tagged, how: 'category' };
  const floor = typeof expected === 'number' && expected > 0 ? expected * MIN_SALARY_SHARE : 0;
  const big = inWindow.filter((l) => l.amount >= floor).sort((a, b) => b.amount - a.amount || b.day - a.day);
  if (big.length) return { lines: [big[0]], how: expected ? 'largest' : 'largest-unchecked' };
  return null;
}

// The current pay period. Returns { start, next, anchor, salary, startSource }.
function payPeriod(today, paydayDay, lines, expectedSalary) {
  const { y, m0 } = ymOfDay(today);
  const anchors = [nominalPayday(y, m0, paydayDay), nominalPayday(y, m0 - 1, paydayDay)];
  for (let i = 0; i < anchors.length; i += 1) {
    const a = anchors[i];
    const found = findSalary(lines, a - PAYDAY_WINDOW_DAYS, Math.min(today, a + PAYDAY_WINDOW_DAYS), expectedSalary);
    const am = ymOfDay(a);
    const next = nominalPayday(am.y, am.m0 + 1, paydayDay);
    if (found) {
      const start = Math.min(...found.lines.map((l) => l.day));
      return { start, next, anchor: a, salary: found, startSource: 'transaction' };
    }
    if (a <= today) return { start: a, next, anchor: a, salary: null, startSource: 'setting' };
  }
  // Unreachable: the previous month's payday is always <= today.
  return null;
}

// Steals log -> one payback line per source, reserve types only.
function stealsPaybacks(rows, { today, startDate, feeRate }) {
  const bySource = new Map();
  (rows || []).forEach((r) => {
    const amount = Number(r.amount) || 0;
    if (amount <= 0 || !r.date) return;
    if (startDate && r.date < startDate) return;
    if (r.date > today) return;
    if (!isReserveType(r.type)) return;
    const dir = norm(r.direction);
    if (dir !== 'steal' && dir !== 'payback') return;
    const key = norm(r.source) || norm(r.type);
    if (!bySource.has(key)) bySource.set(key, { source: r.source || r.type, type: r.type, steals: 0, paybacks: 0, dueDates: [] });
    const g = bySource.get(key);
    if (dir === 'steal') {
      g.steals += amount;
      if (r.dueDate) g.dueDates.push(r.dueDate);
    } else {
      g.paybacks += amount;
    }
  });
  const items = [];
  bySource.forEach((g) => {
    const owed = g.steals - g.paybacks;
    if (owed <= 0.5) return;
    const dates = g.dueDates.slice().sort();
    const upcoming = dates.filter((d) => d >= today);
    const rollDate = upcoming.length ? upcoming[0] : (dates.length ? dates[dates.length - 1] : null);
    const fee = owed * feeRate;
    items.push({ source: g.source, type: g.type, owed: round(owed), fee: round(fee), total: round(owed + fee), rollDate });
  });
  // Soonest rollover first; no date last; then biggest.
  items.sort((a, b) => String(a.rollDate || '9999').localeCompare(String(b.rollDate || '9999')) || b.owed - a.owed);
  return items;
}

// Allowance weeks that start in [start, next).
function allowanceWeeks(start, next, today, weekStartIndex) {
  let ws = weekStartFor(start, weekStartIndex);
  if (ws < start) ws += 7;
  const weeks = [];
  let n = 0;
  for (; ws < next; ws += 7) {
    n += 1;
    const end = ws + 6;
    let status;
    if (end < today) status = 'past';
    else if (ws <= today) status = 'now';
    else if (ws - 7 <= today) status = 'next';
    else status = 'later';
    weeks.push({ n, start: isoFromDay(ws), end: isoFromDay(end), status, crossesPayroll: end >= next });
  }
  return weeks;
}

// inputs: {
//   settings    parseSettings().values
//   txRows      fetchClassifiedTransactionRows()
//   registry    fetchInstallmentRows()
//   accounts    fetchAccountsForReconcile().accounts
//   stealsRows  fetchStealsRows(), or null when there's no tab
//   today       'YYYY-MM-DD' (Jakarta)
// }
function computePayday(inputs) {
  const s = inputs.settings || {};
  const warnings = [];
  const today = dayFromIso(inputs.today);
  if (today === null) throw new Error(`Invalid "date" ${inputs.today} -- expected YYYY-MM-DD`);
  const paydayDay = Number.isInteger(s.payday_day_of_month) && s.payday_day_of_month >= 1 && s.payday_day_of_month <= 31
    ? s.payday_day_of_month : DEFAULT_PAYDAY;
  const expectedSalary = typeof s.monthly_salary_rp === 'number' ? s.monthly_salary_rp : null;
  const allowance = typeof s.weekly_allowance_rp === 'number' ? s.weekly_allowance_rp : null;
  const weekStartIndex = Number.isInteger(s.week_start_index) && s.week_start_index >= 0 ? s.week_start_index : 3;
  const feeRate = typeof s.hole_fee_pct === 'number' ? s.hole_fee_pct : 0.01;
  const accounts = inputs.accounts || [];
  const cardNames = new Set(accounts.filter((a) => isCreditCardType(a.type)).map((a) => norm(a.name)));

  // ---- period + salary ----
  const lines = incomeLines(inputs.txRows, cardNames);
  const p = payPeriod(today, paydayDay, lines, expectedSalary);
  let salaryAmount = null;
  let salary;
  const salaryRows = new Set();
  if (p.salary) {
    p.salary.lines.forEach((l) => salaryRows.add(l.rowNumber));
    salaryAmount = p.salary.lines.reduce((a, l) => a + l.amount, 0);
    salary = {
      amount: salaryAmount,
      source: 'transaction',
      how: p.salary.how,
      date: isoFromDay(Math.min(...p.salary.lines.map((l) => l.day))),
      payee: p.salary.lines[0].payee,
      sof: p.salary.lines[0].sof,
      rows: p.salary.lines.map((l) => l.rowNumber),
      expected: expectedSalary,
    };
    if (p.salary.how === 'largest-unchecked') warnings.push('Salary is a guess: the largest Income near payday (set monthly_salary_rp, or tag the row with Category Salary).');
    else if (p.salary.how === 'largest') warnings.push('Salary picked as the largest Income near payday. Tag it with Category Salary to make it certain.');
  } else {
    salaryAmount = expectedSalary;
    salary = { amount: expectedSalary, source: expectedSalary === null ? null : 'setting', how: null, date: null, payee: null, sof: null, rows: [], expected: expectedSalary };
    warnings.push(expectedSalary === null
      ? 'No salary found this period and monthly_salary_rp is not set.'
      : 'No salary transaction found yet -- using monthly_salary_rp from Settings.');
  }
  if (p.startSource === 'setting') {
    warnings.push(`Pay period starts on payday_day_of_month (${paydayDay}); payroll can land earlier when that day is a weekend or holiday.`);
  }

  // ---- extra income: Income in the period that isn't the salary ----
  const extraItems = lines
    .filter((l) => l.day >= p.start && l.day < p.next && !salaryRows.has(l.rowNumber))
    .sort((a, b) => a.day - b.day)
    .map(({ day, ...rest }) => rest);
  const extraTotal = extraItems.reduce((a, l) => a + l.amount, 0);

  // ---- bills + statements: the Bills page's cycle ----
  // Look at the cycle as of the later of today and the nominal payday, so a
  // salary that landed a day or two early already shows the new cycle.
  const billsRef = Math.max(today, p.anchor);
  const page = buildBillsPage({
    registry: inputs.registry || [],
    txns: inputs.txRows || [],
    accounts,
    salary: salaryAmount,
    today: new Date(billsRef * DAY_MS),
  });
  const billItems = page.cycle.items.filter((i) => i.type === 'bill');
  const stmtItems = page.cycle.items.filter((i) => i.type === 'statement');
  const billsTotal = billItems.reduce((a, i) => a + (Number(i.amount) || 0), 0);
  const stmtTotal = stmtItems.reduce((a, i) => a + (Number(i.amount) || 0), 0);
  if (paydayDay !== PAYROLL_DAY) {
    warnings.push(`Bills and card statements follow the Bills page's cycle (${page.cycle.start} to ${page.cycle.payroll}), which runs from the ${PAYROLL_DAY}th, not payday_day_of_month.`);
  }
  if (page.unsetKinds) warnings.push(`${page.unsetKinds} active bill(s) have no Kind yet; they're placed by the old Ends-year rule.`);

  // ---- Steals paybacks ----
  let hole = null;
  let paybacks = [];
  if (inputs.stealsRows === null || inputs.stealsRows === undefined) {
    warnings.push('No "Steals" tab found -- no paybacks counted.');
  } else {
    const startDate = s.hole_start_date || null;
    hole = actualHole(inputs.stealsRows, { today: inputs.today, startDate });
    paybacks = stealsPaybacks(inputs.stealsRows, { today: inputs.today, startDate, feeRate });
  }
  const principal = paybacks.reduce((a, i) => a + i.owed, 0);
  const fees = paybacks.reduce((a, i) => a + i.fee, 0);
  const paybacksTotal = principal + fees;

  // ---- allowances ----
  const weeks = allowanceWeeks(p.start, p.next, today, weekStartIndex);
  if (allowance === null) warnings.push('weekly_allowance_rp is not set -- allowances count as 0.');
  const weekly = allowance || 0;
  weeks.forEach((w) => { w.amount = weekly; });
  const allowTotal = weekly * weeks.length;

  // ---- what's left ----
  const totalIn = (salaryAmount || 0) + extraTotal;
  const committed = billsTotal + stmtTotal + paybacksTotal + allowTotal;
  const left = totalIn - committed;
  const reborrow = left < 0 ? -left : 0;
  const holeBefore = hole ? round(hole.amount) : null;
  const holeAfter = hole ? round(Math.max(0, hole.amount - principal + reborrow)) : null;
  // Same, if the extra income were kept aside instead of used (preview).
  const leftWithoutExtra = left - extraTotal;
  const holeAfterWithoutExtra = hole
    ? round(Math.max(0, hole.amount - principal + (leftWithoutExtra < 0 ? -leftWithoutExtra : 0)))
    : null;

  const base = salaryAmount || null;
  return {
    today: inputs.today,
    period: {
      start: isoFromDay(p.start),
      nextPayday: isoFromDay(p.next),
      end: isoFromDay(p.next - 1),
      days: p.next - p.start,
      nominalStart: isoFromDay(p.anchor),
      startSource: p.startSource,
      paydayDay,
    },
    salary,
    extraIncome: { total: round(extraTotal), count: extraItems.length, items: extraItems },
    totalIn: round(totalIn),
    bills: {
      count: billItems.length,
      total: round(billsTotal),
      pct: pctOf(billsTotal, base),
      paidCount: billItems.filter((i) => i.status === 'paid').length,
      lateCount: billItems.filter((i) => i.status === 'late').length,
      cycleStart: page.cycle.start,
      cyclePayroll: page.cycle.payroll,
    },
    statements: {
      count: stmtItems.length,
      total: round(stmtTotal),
      pct: pctOf(stmtTotal, base),
      paid: round(stmtItems.reduce((a, i) => a + (Number(i.paidAmount) || 0), 0)),
      remaining: round(stmtItems.reduce((a, i) => a + (i.status === 'paid' ? 0 : Number(i.remaining) || 0), 0)),
      paidCount: stmtItems.filter((i) => i.status === 'paid').length,
    },
    steals: {
      count: paybacks.length,
      principal: round(principal),
      fees: round(fees),
      total: round(paybacksTotal),
      pct: pctOf(paybacksTotal, base),
      feeRate,
      items: paybacks,
    },
    allowances: {
      weekly: allowance,
      weekStartDay: s.week_start_day || 'Wednesday',
      count: weeks.length,
      usual: USUAL_WEEKS,
      unusual: weeks.length !== USUAL_WEEKS,
      total: round(allowTotal),
      pct: pctOf(allowTotal, base),
      weeks,
    },
    committed: round(committed),
    whatsLeft: round(left),
    reborrow: round(reborrow),
    hole: { before: holeBefore, after: holeAfter },
    withoutExtra: { whatsLeft: round(leftWithoutExtra), holeAfter: holeAfterWithoutExtra },
    warnings,
  };
}

// GET /api/cashflow-summary?action=payday[&date=YYYY-MM-DD]. The Sheets
// modules are required here, not at the top, so computePayday() can be
// tested in Node without googleapis.
async function handlePayday(req, res) {
  const q = req.query || {};
  if (q.date && !/^\d{4}-\d{2}-\d{2}$/.test(String(q.date))) {
    res.status(400).json({ error: 'Invalid "date" -- expected YYYY-MM-DD' });
    return;
  }
  const {
    fetchSettings, fetchClassifiedTransactionRows, fetchInstallmentRows, fetchStealsRows, getSheetsClient,
  } = require('./sheets');
  const { fetchAccountsForReconcile } = require('./reconcile');
  const sheets = getSheetsClient();
  const [{ values, warnings: settingsWarnings }, txRows, registry, { accounts }, stealsRows] = await Promise.all([
    fetchSettings(sheets),
    fetchClassifiedTransactionRows(),
    fetchInstallmentRows(),
    fetchAccountsForReconcile(sheets),
    fetchStealsRows(sheets),
  ]);
  let result;
  try {
    result = computePayday({
      settings: values,
      txRows,
      registry,
      accounts,
      stealsRows,
      today: q.date ? String(q.date) : isoFromDay(jakartaToday()),
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
    return;
  }
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({ ...result, settingsWarnings, updatedAt: new Date().toISOString() });
}

module.exports = {
  DEFAULT_PAYDAY,
  PAYDAY_WINDOW_DAYS,
  USUAL_WEEKS,
  nominalPayday,
  incomeLines,
  findSalary,
  payPeriod,
  stealsPaybacks,
  allowanceWeeks,
  computePayday,
  handlePayday,
};
