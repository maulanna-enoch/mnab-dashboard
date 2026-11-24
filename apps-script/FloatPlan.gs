/**
 * FloatPlan.gs — "Set Up Float Plan…"
 *
 * A path off credit card float. "Float" is everyday spending put on a credit
 * card this month and cleared with next month's payroll. That is why every
 * payroll starts out already spent. The plan lowers a monthly cap on new card
 * spending one step at a time. Whatever no longer fits under the cap gets
 * paid from a bank account at the time of purchase, so each statement (and
 * each payroll's first bite) is smaller than the last, until it is zero.
 *
 * The cut has to be paid for: in a month where the cap is R lower, you pay
 * last month's bigger statement AND R of new spending from the bank. So the
 * suggested monthly cut comes from your surplus (Diary left-to-spend).
 *
 * The menu item creates (or rebuilds) one tab, `Float Plan`. Everything in it
 * is a live formula except two settings cells you type into:
 *
 *   B6  Start month          the first card billing month the plan runs.
 *                            Defaults to the current card billing month.
 *   B9  Your monthly cut     optional; leave blank to use the suggestion.
 *
 * Rebuilding keeps whatever is in those two cells.
 *
 * What counts as card float, per card billing month (the `Month` column):
 *   - rows whose SOF is an `Accounts` row with "credit" in its Type,
 *   - net of refunds/cashback (uses `Total` = Expense − Income),
 *   - leaving out Transfer rows (card payments),
 *   - leaving out installment copies, i.e. Notes starting
 *     "Auto-insert NN/MM" (cicilan are scheduled debt, already tracked in
 *     Bills). Plain "Auto-insert" rows — recurring bills charged to a card,
 *     like subscriptions — still count, since they are paid by float too.
 *
 * The numbers:
 *   Baseline float      average card float of the 3 billing months before
 *                       the start month.
 *   Suggested cut       half of the average Diary left-to-spend (Income −
 *                       Expense) of Diary months start−2 … start−4, rounded
 *                       to Rp 10.000, never below 0. Half, so the other half
 *                       is still there for surprises.
 *   Cap, month k        max(0, Baseline − k × Cut), k = 1 for the start month.
 *   Float-free by       the first month whose cap is 0.
 *
 * Going over a month's cap doesn't reset anything; that month just didn't
 * shrink the float, and the next month's cap is still the plan's.
 *
 * Fixed cell positions (the dashboard's /api/cashflow-summary?action=float
 * reads them, so move them only together with api/_lib/float-plan.js):
 *   A3:F3   cap this month, card spend so far, left under cap,
 *           float-free by, months to go, status
 *   B6:B12  start, baseline, suggested cut, your cut, cut used,
 *           months in plan, float-free by
 *   H6:H    cards counted
 *   A16:F   month-by-month table
 *
 * Uses headerIndexMap() from Reconcile.gs (apps-script/Reconciliations.gs),
 * so it must live in the same Apps Script project. Wired to the Finances
 * menu in that file's onOpen().
 */

const FLOAT_CONFIG = {
  sheet: 'Float Plan',
  txnSheet: 'transactions',
  accountsSheet: 'Accounts',
  diarySheet: 'Diary',
  // Diary is read by fixed letters, same as api/_lib/sheets.js fetchDiaryRows.
  diary: { month: 'D', expense: 'G', income: 'H' },
  surplusShare: 0.5,
  baselineMonths: 3,
  maxPlanMonths: 60,
  firstDataRow: 16, // table header on row 15
  moneyFormat: '#,##0',
  monthFormat: 'mmm yyyy',
};

/** Menu entry point. */
function setupFloatPlan() {
  const ui = SpreadsheetApp.getUi();
  const ss = SpreadsheetApp.getActive();
  const C = FLOAT_CONFIG;

  const txn = ss.getSheetByName(C.txnSheet);
  if (!txn) throw new Error('No "' + C.txnSheet + '" tab.');
  const L = floatplan_letters_(headerIndexMap(txn));

  let sheet = ss.getSheetByName(C.sheet);
  let keepStart = null, keepCut = null;
  if (sheet) {
    const answer = ui.alert(
      'Rebuild Float Plan?',
      'The "' + C.sheet + '" tab will be rebuilt. Your start month (B6) and monthly cut (B9) are kept.',
      ui.ButtonSet.OK_CANCEL);
    if (answer !== ui.Button.OK) return;
    keepStart = sheet.getRange('B6').getValue();
    keepCut = sheet.getRange('B9').getValue();
    sheet.clear();
    sheet.clearConditionalFormatRules();
    sheet.getDataRange().clearDataValidations();
  } else {
    sheet = ss.insertSheet(C.sheet);
  }

  floatplan_build_(sheet, L, {
    start: keepStart instanceof Date ? keepStart : floatplan_cardMonth_(new Date()),
    cut: typeof keepCut === 'number' && keepCut > 0 ? keepCut : '',
  });

  SpreadsheetApp.flush();
  ui.alert('Float Plan',
    'Ready. Check "Cards counted" (column H) lists your credit cards, and the baseline in B7 looks right. ' +
      'Type your own monthly cut into B9 if the suggestion in B8 is too fast or too slow.',
    ui.ButtonSet.OK);
  sheet.activate();
}

/** Writes the whole tab. `settings` = { start: Date, cut: number|'' }. */
function floatplan_build_(sheet, L, settings) {
  const C = FLOAT_CONFIG;
  const R = C.firstDataRow;
  const f = floatplan_formulas_(L, R);
  if (sheet.getMaxColumns() < 8) sheet.insertColumnsAfter(sheet.getMaxColumns(), 8 - sheet.getMaxColumns());
  const need = R + C.maxPlanMonths;
  if (sheet.getMaxRows() < need) sheet.insertRowsAfter(sheet.getMaxRows(), need - sheet.getMaxRows());

  // ---- title + scoreboard ----
  sheet.getRange('A1').setValue('Float Plan').setFontSize(14).setFontWeight('bold');
  sheet.getRange('C1').setValue('Goal: stop paying this month with next month\'s payroll.')
    .setFontColor('#666666').setFontStyle('italic');
  sheet.getRange('A2:F2').setValues([[
    'Card cap this month', 'Card spend so far', 'Left under cap', 'Float-free by', 'Months to go', 'Status',
  ]]).setFontColor('#666666').setFontSize(9);
  sheet.getRange('A3:F3').setFormulas([[f.kpiCap, f.kpiSpend, f.kpiLeft, f.kpiFreeBy, f.kpiMonthsLeft, f.kpiStatus]])
    .setFontSize(13).setFontWeight('bold');
  sheet.getRange('A3:C3').setNumberFormat(C.moneyFormat);
  sheet.getRange('D3').setNumberFormat(C.monthFormat);
  sheet.getRange('E3').setNumberFormat('0');

  // ---- settings ----
  sheet.getRange('A5').setValue('Settings').setFontWeight('bold');
  sheet.getRange('A6:A12').setValues([
    ['Start month'],
    ['Baseline float'],
    ['Suggested monthly cut'],
    ['Your monthly cut (optional)'],
    ['Monthly cut used'],
    ['Months in plan'],
    ['Float-free by'],
  ]);
  sheet.getRange('B6').setValue(settings.start).setNumberFormat(C.monthFormat);
  sheet.getRange('B7:B8').setFormulas([[f.baseline], [f.suggested]]);
  sheet.getRange('B9').setValue(settings.cut);
  sheet.getRange('B10:B12').setFormulas([[f.cutUsed], [f.planMonths], [f.freeBy]]);
  sheet.getRange('B7:B10').setNumberFormat(C.moneyFormat);
  sheet.getRange('B11').setNumberFormat('0');
  sheet.getRange('B12').setNumberFormat(C.monthFormat);
  sheet.getRange('B6').setBackground('#fff8e1').setDataValidation(
    SpreadsheetApp.newDataValidation().requireDate().setAllowInvalid(false)
      .setHelpText('A card billing month, e.g. 01/12/2026 for Dec 2026.').build());
  sheet.getRange('B9').setBackground('#fff8e1').setDataValidation(
    SpreadsheetApp.newDataValidation().requireNumberGreaterThan(0).setAllowInvalid(false)
      .setHelpText('Rupiah per month. Leave blank to use the suggestion above.').build());
  sheet.getRange('C6:C12').setValues([
    ['First card billing month of the plan. You can type here.'],
    ['Average card float of the ' + C.baselineMonths + ' billing months before the start (cicilan and card payments left out).'],
    ['Half of your average Diary left-to-spend, rounded. The other half stays for surprises.'],
    ['You can type here. Blank = use the suggestion.'],
    ['How much lower the card cap gets each month.'],
    [''],
    ['First month with a card cap of 0.'],
  ]).setFontColor('#888888').setFontStyle('italic');

  sheet.getRange('H5').setValue('Cards counted').setFontWeight('bold');
  sheet.getRange('H6').setFormula(f.cards);
  sheet.getRange('H5').setNote('Accounts whose Type contains "credit". Their spending is what the plan counts as float.');

  // ---- month by month ----
  sheet.getRange('A14').setValue('Month by month').setFontWeight('bold');
  sheet.getRange(R - 1, 1, 1, 6).setValues([[
    'Card month', 'Card cap', 'Card spend', 'Under (+) / over (−) cap', 'Status', 'Pay from bank instead',
  ]]).setFontWeight('bold').setBackground('#f1f3f4').setWrap(true);
  sheet.getRange(R - 1, 6).setNote(
    'How much of your usual card spending this month should be paid from a bank account instead. ' +
      'This is the extra cash the plan needs from your surplus.');
  sheet.getRange(R, 1, 1, 6).setFormulas([[f.month, f.cap, f.spend, f.delta, f.status, f.fromBank]]);

  const rows = sheet.getMaxRows() - R + 1;
  sheet.getRange(R, 1, rows, 1).setNumberFormat(C.monthFormat);
  sheet.getRange(R, 2, rows, 2).setNumberFormat(C.moneyFormat);
  sheet.getRange(R, 4, rows, 1).setNumberFormat('+#,##0;-#,##0;0');
  sheet.getRange(R, 6, rows, 1).setNumberFormat(C.moneyFormat);

  // ---- colours ----
  const green = '#137333', greenBg = '#e6f4ea', red = '#c5221f', redBg = '#fce8e6';
  const statusRanges = [sheet.getRange(R, 5, rows, 1), sheet.getRange('F3')];
  const deltaRanges = [sheet.getRange(R, 4, rows, 1), sheet.getRange('C3')];
  sheet.setConditionalFormatRules([
    SpreadsheetApp.newConditionalFormatRule().whenTextStartsWith('✓')
      .setFontColor(green).setBackground(greenBg).setRanges(statusRanges).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextStartsWith('⏳')
      .setFontColor(green).setRanges(statusRanges).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextStartsWith('✗')
      .setFontColor(red).setBackground(redBg).setRanges(statusRanges).build(),
    SpreadsheetApp.newConditionalFormatRule().whenNumberLessThan(0)
      .setFontColor(red).setRanges(deltaRanges).build(),
    SpreadsheetApp.newConditionalFormatRule().whenNumberGreaterThanOrEqualTo(0)
      .setFontColor(green).setRanges(deltaRanges).build(),
  ]);

  sheet.setFrozenRows(3);
  sheet.setColumnWidth(1, 170);
  sheet.setColumnWidths(2, 5, 130);
  sheet.setColumnWidth(3, 130);
  sheet.setColumnWidth(5, 150);
  sheet.setColumnWidth(8, 160);
  sheet.setRowHeight(R - 1, 36);
}

/**
 * Builds every formula. `L` maps transactions header -> column letter (see
 * floatplan_letters_); `R` is the first data row of the table. Pure (no Sheet
 * calls), so it can be tested outside Apps Script.
 */
function floatplan_formulas_(L, R) {
  const C = FLOAT_CONFIG;
  const q = function (name) { return "'" + name + "'!"; };
  const t = q(C.txnSheet), acc = q(C.accountsSheet), di = q(C.diarySheet);
  const rng = function (sheet, letter) { return sheet + '$' + letter + '$2:$' + letter; };

  const sof = rng(t, L.SOF), mon = rng(t, L.Month), tot = rng(t, L.Total), notes = rng(t, L.Notes);
  const cards = '$H$6:$H$40';
  // Normalises any date in a Month cell to the 1st of its month; blank/text -> 0.
  const asMonth = function (r) { return 'IFERROR(EOMONTH(' + r + ', -1) + 1, 0)'; };
  const transferTerm = L.Transfer ? ' * (' + rng(t, L.Transfer) + ' & "" <> "TRUE")' : '';
  // Net card float for billing month m (a first-of-month date).
  const spendIn = function (m) {
    return 'SUMPRODUCT(ARRAYFORMULA((' + sof + ' <> "") * ISNUMBER(MATCH(' + sof + ', ' + cards + ', 0))' +
      ' * (' + asMonth(mon) + ' = ' + m + ')' + transferTerm +
      ' * NOT(REGEXMATCH(' + notes + ' & "", "^Auto-insert \\d+/\\d+"))' +
      ' * IFERROR(' + tot + ' * 1, 0)))';
  };
  // Diary Income − Expense for month m.
  const leftIn = function (m) {
    const dm = rng(di, C.diary.month);
    return 'SUMPRODUCT(ARRAYFORMULA((' + asMonth(dm) + ' = ' + m + ') * (IFERROR(' + rng(di, C.diary.income) + ' * 1, 0) - ' +
      'IFERROR(' + rng(di, C.diary.expense) + ' * 1, 0))))';
  };
  // Current card billing month: day 1-12 -> this month, 13+ -> next month.
  const cardNow = 'IF(DAY(TODAY()) <= 12, DATE(YEAR(TODAY()), MONTH(TODAY()), 1), ' +
    'DATE(YEAR(TODAY()), MONTH(TODAY()) + 1, 1))';
  const monthsFrom = function (a, b) { return '((YEAR(' + b + ') - YEAR(' + a + ')) * 12 + MONTH(' + b + ') - MONTH(' + a + '))'; };
  const col = function (c) { return c + R + ':' + c + (R + C.maxPlanMonths - 1); };
  const A = col('A'), B = col('B'), D = col('D'), E = col('E');
  const start = '$B$6', base = '$B$7', cut = '$B$10', n = '$B$11';

  return {
    cards: '=IFERROR(FILTER(' + acc + 'A2:A, ' + acc + 'A2:A <> "", ' +
      'REGEXMATCH(LOWER(' + acc + 'B2:B & ""), "credit")), "No credit card accounts found")',

    baseline: '=IF(ISNUMBER(' + start + '), ROUND(AVERAGE(MAP(SEQUENCE(' + C.baselineMonths + '), ' +
      'LAMBDA(k, ' + spendIn('EDATE(' + start + ', -k)') + '))), -3), "")',
    suggested: '=IF(ISNUMBER(' + start + '), MAX(0, ROUND(' + C.surplusShare + ' * AVERAGE(MAP(SEQUENCE(3, 1, 2), ' +
      'LAMBDA(k, ' + leftIn('EDATE(' + start + ', -k)') + '))), -4)), "")',
    cutUsed: '=IF(AND(ISNUMBER(B9), B9 > 0), B9, B8)',
    planMonths: '=IF(AND(ISNUMBER(' + base + '), ISNUMBER(' + cut + '), ' + cut + ' > 0), ' +
      'MIN(' + C.maxPlanMonths + ', MAX(1, ROUNDUP(' + base + ' / ' + cut + ', 0))), "")',
    freeBy: '=IF(ISNUMBER(' + n + '), EDATE(' + start + ', ' + n + ' - 1), "")',

    // Plan months, extended to the current card month if the plan is already over.
    month: '=IF(ISNUMBER(' + n + '), LET(c, ' + cardNow + ', ' +
      'cnt, MIN(' + C.maxPlanMonths + ', MAX(' + n + ', ' + monthsFrom(start, 'c') + ' + 1)), ' +
      'DATE(YEAR(' + start + '), MONTH(' + start + ') + SEQUENCE(cnt) - 1, 1)), "")',
    cap: '=MAP(' + A + ', LAMBDA(m, IF(m = "", "", MAX(0, ' + base + ' - (' + monthsFrom(start, 'm') + ' + 1) * ' + cut + '))))',
    spend: '=MAP(' + A + ', LAMBDA(m, IF(OR(m = "", m > ' + cardNow + '), "", ' + spendIn('m') + ')))',
    delta: '=MAP(' + A + ', ' + B + ', ' + col('C') + ', LAMBDA(m, b, s, IF(OR(m = "", s = ""), "", b - s)))',
    status: '=MAP(' + A + ', ' + B + ', ' + D + ', LAMBDA(m, b, d, IF(m = "", "", ' +
      'IF(d = "", IF(b = 0, "Float-free month", "Upcoming"), ' +
      'IF(m = ' + cardNow + ', IF(d >= 0, "⏳ On track", "✗ Over cap already"), ' +
      'IF(d >= 0, IF(b = 0, "✓ Float-free", "✓ Under cap"), "✗ Over cap"))))))',
    fromBank: '=MAP(' + B + ', LAMBDA(b, IF(b = "", "", ' + base + ' - b)))',

    kpiCap: '=IFERROR(XLOOKUP(' + cardNow + ', ' + A + ', ' + B + '), "—")',
    kpiSpend: '=' + spendIn(cardNow),
    kpiLeft: '=IFERROR(A3 - B3, "—")',
    kpiFreeBy: '=B12',
    kpiMonthsLeft: '=IF(ISNUMBER(B12), MAX(0, ' + monthsFrom(cardNow, 'B12') + '), "—")',
    kpiStatus: '=IF(NOT(ISNUMBER(' + n + ')), "Set a monthly cut in B9", ' +
      'IF(' + cardNow + ' < ' + start + ', "Starts " & TEXT(' + start + ', "mmm yyyy"), ' +
      'IFERROR(XLOOKUP(' + cardNow + ', ' + A + ', ' + E + '), "—")))',
  };
}

/** transactions header -> column letter. Transfer is optional; the rest must exist. */
function floatplan_letters_(col) {
  const out = {};
  ['SOF', 'Month', 'Total', 'Notes'].forEach(function (h) {
    if (!(h in col)) throw new Error('"' + FLOAT_CONFIG.txnSheet + '" is missing the "' + h + '" column.');
    out[h] = floatplan_colLetter_(col[h] + 1);
  });
  if ('Transfer' in col) out.Transfer = floatplan_colLetter_(col['Transfer'] + 1);
  return out;
}

/** The card billing month a date falls in: day 1-12 -> that month, 13+ -> next month. */
function floatplan_cardMonth_(d) {
  return new Date(d.getFullYear(), d.getMonth() + (d.getDate() <= 12 ? 0 : 1), 1);
}

/** 1-based column number -> letter(s): 1 -> A, 27 -> AA. */
function floatplan_colLetter_(n) {
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}
