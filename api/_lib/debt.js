// Actual hole and debt projection (Debt Exit plan, WS6).
//
// Two questions:
//   1. How big is the hole right now?  -> actualHole()
//   2. When is it paid off?            -> projectDebt()
//
// ---- 1. Actual hole ------------------------------------------------------
//
// Read from the `Steals` log (apps-script/Steals.gs): Steal rows minus
// Payback rows, counting the reserve types only -- the same figure as
// "Owed to future (reserves)" on the Steals Summary tab. A credit card cash
// advance or paylater is left out (paying that bill next month isn't a
// payback, so it would never come off the total). RESERVE_TYPES must stay in
// step with STEALS_CONFIG.reserveTypes in Steals.gs.
//
// Rows dated before hole_start_date (Settings) are ignored when it's set,
// and rows dated after today are ignored (not happened yet).
//
// ---- 2. Projection -------------------------------------------------------
//
// A straight port of the Claude Sheet's "Payoff plan" tab, one row per
// statement month, starting the month after this one (the hole today is
// this month's figure, like the sheet's "Hole today" for Nov 2026):
//
//   holeStart  = last month's holeLeft (first month: the actual hole)
//   fee        = holeStart * feeRate                       (sheet col I)
//   bills      = bills committed that month                (sheet col C)
//   extra      = THR (its month only) + raise uplift       (sheet col D)
//   capacity   = salary + extra - bills - dayToDay
//   holeLeft   = max(0, holeStart + fee - capacity)        (sheet col F)
//   spare      = max(0, capacity - (holeStart + fee))      (sheet col G)
//   paidDown   = holeStart + fee - holeLeft                (sheet col E)
//
//   Debt-free month = the month after the LAST month that still has a hole
//   (sheet B1, "debt-free for good"); null if it's still open at the end.
//
// Units don't matter: the sheet runs it with salary = 1 and everything as a
// fraction of salary; MNAB runs it in rupiah. Same function either way.
//
// Inputs that differ from the sheet only in where they come from:
//   - dayToDay  = weekly_allowance_rp * 52 / 12 (the sheet's weekly
//                 allowance is the monthly figure * 12 / 52)
//   - bills     = the installmentsbills registry (WS2). A bill counts from
//                 its Starts month (blank = always) until its "first
//                 statement free" month, which is the sheet's rule:
//                 paid by card -> Ends day <= 12 ? Ends month + 1 : + 2;
//                 paid from cash -> Ends month + 1. Ends blank or 2099+ =
//                 never ends. Paid by card = Kind "Card bill", or an
//                 installment whose SOF is a credit card account.
//   - THR       = one payment in thr_date's month: thr_rp if set, else
//                 min(12, full months from job_start_date to thr_date) / 12
//                 * salary; times thr_share_pct. Like the sheet, only that
//                 one THR is modelled.
//   - raises    = from first_raise_date, (1 + raise_pct)^(whole years
//                 since + 1) - 1, as extra income on top of salary.
//
// "At your pace" runs the same projection with dayToDay moved by the
// average weekly over/under-spend of recent completed weeks (WS4), and
// "last week moved it" compares the estimated debt-free DATE with and
// without last week's over/under-spend added to today's hole. The
// estimated date interpolates inside the debt-free month (how much of that
// month's room the last bit of hole uses up), so a small change shows as
// days rather than as nothing.
//
// Months are 'YYYY-MM' strings. Pure functions only, no Sheets API: the
// endpoint is GET /api/cashflow-summary?action=debt.

const { addMonths, isOpenEndDate, monthOf } = require('./bills');

const RESERVE_TYPES = ['Penarikan Reksadana', 'Pinjaman', 'Tabungan / Dana Darurat'];
const DEFAULT_HORIZON_MONTHS = 60;
const DEFAULT_PACE_WEEKS = 4;
const WEEKS_PER_MONTH = 52 / 12;
// Sheet B1 treats anything at or under 0.00001 (of salary) as paid off.
const PAID_OFF_EPSILON = 0.00001;

const DAY_MS = 24 * 60 * 60 * 1000;
const pad2 = (n) => String(n).padStart(2, '0');

function norm(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}
const RESERVE_SET = new Set(RESERVE_TYPES.map(norm));

function isReserveType(type) {
  return RESERVE_SET.has(norm(type));
}

// rows: from fetchStealsRows() -- { rowNumber, date ('YYYY-MM-DD' | null),
// direction, type, source, amount }.
// options: { today ('YYYY-MM-DD'), startDate ('YYYY-MM-DD' | null) }
function actualHole(rows, options = {}) {
  const today = options.today || null;
  const startDate = options.startDate || null;
  const byType = {};
  let steals = 0;
  let paybacks = 0;
  let counted = 0;
  const skipped = { notReserve: 0, beforeStart: 0, future: 0, undated: 0, unknownDirection: 0 };

  (rows || []).forEach((r) => {
    const amount = Number(r.amount) || 0;
    if (amount <= 0) return;
    if (!r.date) { skipped.undated += 1; return; }
    if (startDate && r.date < startDate) { skipped.beforeStart += 1; return; }
    if (today && r.date > today) { skipped.future += 1; return; }
    if (!isReserveType(r.type)) { skipped.notReserve += 1; return; }
    const dir = norm(r.direction);
    if (dir !== 'steal' && dir !== 'payback') { skipped.unknownDirection += 1; return; }
    const key = RESERVE_TYPES.find((t) => norm(t) === norm(r.type));
    if (!byType[key]) byType[key] = { type: key, steals: 0, paybacks: 0, owed: 0 };
    if (dir === 'steal') { steals += amount; byType[key].steals += amount; }
    else { paybacks += amount; byType[key].paybacks += amount; }
    byType[key].owed = byType[key].steals - byType[key].paybacks;
    counted += 1;
  });

  return {
    amount: Math.max(0, steals - paybacks),
    steals,
    paybacks,
    rowsCounted: counted,
    skipped,
    byType: RESERVE_TYPES.filter((t) => byType[t]).map((t) => byType[t]),
    startDate,
  };
}

// ---- dates ---------------------------------------------------------------

function parseIso(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  return m ? { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) } : null;
}

function monthOfIso(s) {
  const p = parseIso(s);
  return p ? `${p.y}-${pad2(p.m)}` : null;
}

function daysInMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function dayNumber(iso) {
  const p = parseIso(iso);
  return p ? Date.UTC(p.y, p.m - 1, p.d) / DAY_MS : null;
}

function monthDiff(from, to) {
  const [fy, fm] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  return (ty - fy) * 12 + (tm - fm);
}

// Full months of service, as the sheet's Assumptions!B7.
function fullMonthsBetween(fromIso, toIso) {
  const a = parseIso(fromIso);
  const b = parseIso(toIso);
  if (!a || !b) return null;
  return (b.y - a.y) * 12 + (b.m - a.m) - (b.d < a.d ? 1 : 0);
}

// ---- bills ---------------------------------------------------------------

// The sheet's "First statement free" column, as a 'YYYY-MM', or null when
// the bill never ends.
function firstFreeMonth(row, paidByCard) {
  if (isOpenEndDate(row.endDate)) return null;
  const endMonth = monthOf(row.endDate);
  if (!paidByCard) return addMonths(endMonth, 1);
  return addMonths(endMonth, row.endDate.getUTCDate() <= 12 ? 1 : 2);
}

// Registry rows (fetchInstallmentRows) -> month -> total committed, with the
// sheet's timing. isCardRow(row) says whether a row is paid by card.
function planBillsFn(rows, isCardRow) {
  const prepared = (rows || [])
    .filter((r) => r.isActive && Number(r.amount) > 0)
    .map((r) => ({
      amount: Number(r.amount),
      startMonth: r.startDate ? monthOf(r.startDate) : null,
      freeMonth: firstFreeMonth(r, !!(isCardRow && isCardRow(r))),
    }));
  return (month) => prepared.reduce((sum, r) => {
    if (r.startMonth && month < r.startMonth) return sum;
    if (r.freeMonth && month >= r.freeMonth) return sum;
    return sum + r.amount;
  }, 0);
}

// ---- extra income --------------------------------------------------------

// settings: parseSettings().values. Returns { fn, thr, raise, warnings }.
function extraIncomeFn(settings, salary) {
  const s = settings || {};
  const warnings = [];
  let thr = null;
  if (s.thr_date) {
    const month = monthOfIso(s.thr_date);
    const share = typeof s.thr_share_pct === 'number' ? s.thr_share_pct : 1;
    let gross = null;
    let basis = null;
    if (typeof s.thr_rp === 'number') {
      gross = s.thr_rp;
      basis = 'thr_rp';
    } else if (s.job_start_date) {
      const months = fullMonthsBetween(s.job_start_date, s.thr_date);
      if (months !== null && months >= 1) {
        gross = (Math.min(12, months) / 12) * salary;
        basis = `${Math.min(12, months)}/12 of salary`;
      } else {
        warnings.push('thr_date is before a full month of service -- no THR counted.');
      }
    } else {
      warnings.push('thr_date is set but neither thr_rp nor job_start_date is -- no THR counted.');
    }
    if (gross !== null) thr = { month, amount: gross * share, gross, share, basis };
  }

  let raise = null;
  if (s.first_raise_date && typeof s.raise_pct === 'number' && s.raise_pct > 0) {
    raise = { pct: s.raise_pct, fromMonth: monthOfIso(s.first_raise_date) };
  }

  const fn = (month) => {
    let extra = 0;
    if (thr && month === thr.month) extra += thr.amount;
    if (raise && month >= raise.fromMonth) {
      const years = Math.floor(monthDiff(raise.fromMonth, month) / 12) + 1;
      extra += (Math.pow(1 + raise.pct, years) - 1) * salary;
    }
    return extra;
  };
  return { fn, thr, raise, warnings };
}

// ---- simulation ----------------------------------------------------------

// The Payoff plan, month by month.
// p: { startMonth, months, hole, salary, feeRate, dayToDay,
//      billsFor(month), extraFor(month) }
function simulate(p) {
  const months = Number.isInteger(p.months) && p.months > 0 ? p.months : DEFAULT_HORIZON_MONTHS;
  const eps = PAID_OFF_EPSILON * (p.salary || 1);
  const rows = [];
  let hole = Math.max(0, Number(p.hole) || 0);
  for (let i = 0; i < months; i += 1) {
    const month = addMonths(p.startMonth, i);
    const bills = p.billsFor ? p.billsFor(month) : 0;
    const extra = p.extraFor ? p.extraFor(month) : 0;
    const holeStart = hole;
    const fee = holeStart * p.feeRate;
    const capacity = p.salary + extra - bills - p.dayToDay;
    const holeLeft = Math.max(0, holeStart + fee - capacity);
    const spare = Math.max(0, capacity - (holeStart + fee));
    rows.push({ month, bills, extra, holeStart, fee, capacity, paidDown: holeStart + fee - holeLeft, holeLeft, spare });
    hole = holeLeft;
  }

  // Sheet B1: "Not by <end>" if the last month still has a hole; else the
  // month after the last month with one; else (never had one) the first.
  const last = rows[rows.length - 1];
  let debtFreeMonth = null;
  let clearingIndex = null;
  if (!(last.holeLeft > eps)) {
    let lastWithHole = -1;
    rows.forEach((r, i) => { if (r.holeLeft > eps) lastWithHole = i; });
    clearingIndex = lastWithHole + 1;
    debtFreeMonth = lastWithHole === -1 ? rows[0].month : addMonths(rows[lastWithHole].month, 1);
  }

  // Estimated day inside the clearing month: the share of that month's
  // room the remaining hole (plus fee) uses up.
  let estimatedDate = null;
  if (clearingIndex !== null) {
    const r = rows[clearingIndex];
    if (r) {
      const owed = r.holeStart + r.fee;
      let frac = 0;
      if (owed > eps && r.capacity > 0) frac = Math.min(1, owed / r.capacity);
      const dim = daysInMonth(r.month);
      const day = Math.max(1, Math.min(dim, Math.ceil(frac * dim)));
      estimatedDate = `${r.month}-${pad2(day)}`;
    } else {
      estimatedDate = `${debtFreeMonth}-01`;
    }
  }

  let peak = null;
  rows.forEach((r) => { if (!peak || r.holeLeft > peak.amount) peak = { month: r.month, amount: r.holeLeft }; });

  return { rows, debtFreeMonth, estimatedDate, peak, horizonEnd: last.month };
}

function daysBetween(a, b) {
  if (!a || !b) return null;
  return dayNumber(b) - dayNumber(a);
}

// ---- pace from the weekly budget (WS4) -----------------------------------

// week: computeWeek() output. Completed weeks with an allowance, newest
// last. Deviation = spent - allowance (overspend positive), before rollover
// -- rollover moves money between weeks, it doesn't change the total spent.
function weeklyDeviations(week) {
  if (!week || !Array.isArray(week.history)) return [];
  return week.history
    .filter((w) => !w.beforeBudgetStart && typeof w.allowance === 'number')
    .map((w) => ({ start: w.start, end: w.end, spent: w.spent, allowance: w.allowance, deviation: w.spent - w.allowance }));
}

// ---- the whole answer ----------------------------------------------------

const round = (n) => (typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : n);
const pct = (n, salary) => (typeof n === 'number' && salary ? Math.round((n / salary) * 10000) / 10000 : null);

function publicRows(rows, salary) {
  return rows.map((r) => ({
    month: r.month,
    bills: round(r.bills),
    extraIncome: round(r.extra),
    holeStart: round(r.holeStart),
    fee: round(r.fee),
    paidDown: round(r.paidDown),
    holeLeft: round(r.holeLeft),
    spare: round(r.spare),
    holeLeftPct: pct(r.holeLeft, salary),
  }));
}

// inputs: {
//   settings      parseSettings().values
//   stealsRows    fetchStealsRows() result, or null when there's no tab
//   billRows      fetchInstallmentRows()
//   isCardRow     (row) => boolean
//   week          computeWeek() result (for pace and last week), optional
//   today         'YYYY-MM-DD' (Jakarta)
// }
// options: { months, paceWeeks, includeMonths }
function projectDebt(inputs, options = {}) {
  const s = inputs.settings || {};
  const warnings = [];
  const today = inputs.today;
  const currentMonth = monthOfIso(today);
  const salary = typeof s.monthly_salary_rp === 'number' ? s.monthly_salary_rp : null;
  const allowance = typeof s.weekly_allowance_rp === 'number' ? s.weekly_allowance_rp : null;
  const feeRate = typeof s.hole_fee_pct === 'number' ? s.hole_fee_pct : 0.01;

  let hole = null;
  if (inputs.stealsRows === null || inputs.stealsRows === undefined) {
    warnings.push('No "Steals" tab found -- set it up from Finances › Setup › Steals from the Future….');
  } else {
    hole = actualHole(inputs.stealsRows, { today, startDate: s.hole_start_date || null });
    if (!s.hole_start_date) warnings.push('hole_start_date is not set -- the hole counts every Steals row.');
    if (hole.skipped.undated) warnings.push(`${hole.skipped.undated} Steals row(s) have no date and aren't counted.`);
    if (hole.skipped.unknownDirection) warnings.push(`${hole.skipped.unknownDirection} Steals row(s) have a Direction other than Steal/Payback and aren't counted.`);
  }

  const out = {
    today,
    currentMonth,
    hole: hole && {
      amount: round(hole.amount),
      pctOfSalary: pct(hole.amount, salary),
      steals: round(hole.steals),
      paybacks: round(hole.paybacks),
      rowsCounted: hole.rowsCounted,
      skipped: hole.skipped,
      byType: hole.byType.map((t) => ({ type: t.type, steals: round(t.steals), paybacks: round(t.paybacks), owed: round(t.owed) })),
      startDate: hole.startDate,
      reserveTypes: RESERVE_TYPES,
    },
    inputs: null,
    plan: null,
    pace: null,
    lastWeek: null,
    warnings,
  };

  if (salary === null) warnings.push('monthly_salary_rp is not set -- no projection.');
  if (allowance === null) warnings.push('weekly_allowance_rp is not set -- no projection.');
  if (!hole || salary === null || allowance === null) return out;

  const billsFor = planBillsFn(inputs.billRows, inputs.isCardRow);
  const extra = extraIncomeFn(s, salary);
  extra.warnings.forEach((w) => warnings.push(w));
  const dayToDay = allowance * WEEKS_PER_MONTH;
  const startMonth = addMonths(currentMonth, 1);
  const months = Number.isInteger(options.months) && options.months > 0 ? Math.min(options.months, 240) : DEFAULT_HORIZON_MONTHS;
  const base = { startMonth, months, salary, feeRate, billsFor, extraFor: extra.fn };

  const plan = simulate({ ...base, hole: hole.amount, dayToDay });

  out.inputs = {
    salary: round(salary),
    weeklyAllowance: round(allowance),
    dayToDayMonthly: round(dayToDay),
    dayToDayPct: pct(dayToDay, salary),
    feeRate,
    billsThisMonth: round(billsFor(currentMonth)),
    billsThisMonthPct: pct(billsFor(currentMonth), salary),
    thr: extra.thr && { month: extra.thr.month, amount: round(extra.thr.amount), basis: extra.thr.basis, share: extra.thr.share },
    raise: extra.raise,
    startMonth,
    horizonEnd: plan.horizonEnd,
  };
  if (!extra.thr) warnings.push('No THR in the projection (thr_date not set).');
  if (!extra.raise) warnings.push('No raises in the projection (first_raise_date not set).');

  out.plan = {
    debtFreeMonth: plan.debtFreeMonth,
    estimatedDate: plan.estimatedDate,
    peak: plan.peak && { month: plan.peak.month, amount: round(plan.peak.amount), pct: pct(plan.peak.amount, salary) },
    peakAfterThr: null,
  };
  // Sheet B2: the highest hole left in the months after the THR month.
  if (extra.thr) {
    const after = plan.rows.filter((r) => r.month > extra.thr.month);
    if (after.length) {
      const top = after.reduce((a, r) => (r.holeLeft > a.holeLeft ? r : a), after[0]);
      out.plan.peakAfterThr = { month: top.month, amount: round(top.holeLeft), pct: pct(top.holeLeft, salary) };
    }
  }
  if (options.includeMonths !== false) out.plan.months = publicRows(plan.rows, salary);

  // At your pace: recent average weekly over/under-spend.
  const devs = weeklyDeviations(inputs.week);
  const paceWeeks = Number.isInteger(options.paceWeeks) && options.paceWeeks > 0 ? options.paceWeeks : DEFAULT_PACE_WEEKS;
  const recent = devs.slice(-paceWeeks);
  if (recent.length) {
    const avg = recent.reduce((a, w) => a + w.deviation, 0) / recent.length;
    const paced = simulate({ ...base, hole: hole.amount, dayToDay: dayToDay + avg * WEEKS_PER_MONTH });
    out.pace = {
      weeks: recent.length,
      avgWeeklyDeviation: round(avg),
      debtFreeMonth: paced.debtFreeMonth,
      estimatedDate: paced.estimatedDate,
      daysVsPlan: daysBetween(plan.estimatedDate, paced.estimatedDate),
    };
  }

  // Last week: its over/under-spend added to (or taken off) today's hole.
  const lw = devs[devs.length - 1];
  if (lw) {
    const moved = simulate({ ...base, hole: Math.max(0, hole.amount + lw.deviation), dayToDay });
    out.lastWeek = {
      start: lw.start,
      end: lw.end,
      spent: round(lw.spent),
      allowance: round(lw.allowance),
      deviation: round(lw.deviation),
      // Positive = pushed the debt-free date later.
      movedDays: daysBetween(plan.estimatedDate, moved.estimatedDate),
      withoutItDate: plan.estimatedDate,
      withItDate: moved.estimatedDate,
    };
  }

  return out;
}

module.exports = {
  RESERVE_TYPES,
  DEFAULT_HORIZON_MONTHS,
  DEFAULT_PACE_WEEKS,
  isReserveType,
  actualHole,
  firstFreeMonth,
  planBillsFn,
  extraIncomeFn,
  fullMonthsBetween,
  simulate,
  weeklyDeviations,
  projectDebt,
};
