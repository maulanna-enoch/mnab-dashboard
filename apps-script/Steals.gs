/**
 * Steals.gs — "Set Up Steals from the Future…"
 *
 * Tracks money borrowed from your future self: cash advances on a credit
 * card (penarikan dana CC), selling mutual funds (penarikan reksadana),
 * paylater, loans, dipping into savings, and so on. The rule it measures:
 * the total stolen each month should be lower than the month before.
 *
 * The menu item creates (or repairs) two tabs. It never touches rows you've
 * typed into the log.
 *
 * `Steals` (the log, one row per event, typed in by hand)
 *   Date       when it happened
 *   Direction  Steal   = took from the future
 *              Payback = put it back (topped the reksadana up again, repaid
 *                        a loan, refilled savings)
 *   Type       what kind (STEALS_CONFIG.types); for a Payback, the kind
 *              being repaid
 *   Source     where it came from, e.g. "UOB Preferred", "Bibit RDPU"
 *   Amount     rupiah, > 0, without the fee
 *   Fee        what the steal cost on top (cash advance fee, interest,
 *              redemption fee). Optional
 *   Reason     why it was needed
 *   Notes
 *   Month      formula, don't type here: the calendar month of Date
 *
 * `Steals Summary` (formulas only, rebuilt by this menu item)
 *   Top: this month vs last month, status, streak of months that came in
 *   lower, reserves still owed to the future, and a sparkline.
 *   Table, one row per month from the first logged month to now (months
 *   with no steals show 0 — those count as wins):
 *     Month, Steals, vs Last Month, Trend, Paybacks, Net, Owed to Future,
 *     Fees, then Steals split by Type.
 *   Trend: "✓ Zero", "✓ Lower", "✗ Not lower", "— First month"; the current
 *   (unfinished) month says "✓ On track" or "✗ Already ≥ last month".
 *   The streak counts finished months only.
 *   Owed to Future counts reserve types only (STEALS_CONFIG.reserveTypes:
 *   reksadana, savings, loans): what was taken out of a reserve and not put
 *   back yet. A credit card cash advance or paylater is left out. Paying
 *   that bill next month isn't a Payback (next month's income is paying
 *   for it), so it would never come off the total.
 *
 * This log stands on its own: it doesn't read or write `transactions`. The
 * cash advance or redemption itself still goes into `transactions` as
 * usual; logging it here as well is what puts it on the scoreboard.
 *
 * Uses headerIndexMap() and ensureColumn() from Reconcile.gs
 * (apps-script/Reconciliations.gs), so it must live in the same Apps Script
 * project. Wired to the Finances menu in that file's onOpen().
 */

const STEALS_CONFIG = {
  logSheet: 'Steals',
  summarySheet: 'Steals Summary',
  directions: ['Steal', 'Payback'],
  types: [
    'Penarikan Dana CC',
    'Penarikan Reksadana',
    'Paylater',
    'Pinjaman',
    'Tabungan / Dana Darurat',
    'Lainnya',
  ],
  // Types counted in Owed to Future: reserves you draw down and can refill
  // with a Payback. Must be names from `types`.
  reserveTypes: [
    'Penarikan Reksadana',
    'Pinjaman',
    'Tabungan / Dana Darurat',
  ],
  // Log columns in the order a new tab gets them. An existing tab is matched
  // by header name, so reordering columns later is fine.
  logHeaders: ['Date', 'Direction', 'Type', 'Source', 'Amount', 'Fee', 'Reason', 'Notes', 'Month'],
  moneyFormat: '#,##0',
  dateFormat: 'dd/mm/yyyy',
  monthFormat: 'mmm yyyy',
  firstDataRow: 6, // summary table: header on row 5, months from row 6
};

/** Menu entry point. */
function setupSteals() {
  const ui = SpreadsheetApp.getUi();
  const ss = SpreadsheetApp.getActive();

  let summary = ss.getSheetByName(STEALS_CONFIG.summarySheet);
  if (summary) {
    const answer = ui.alert(
      'Rebuild Steals Summary?',
      'The "' + STEALS_CONFIG.summarySheet + '" tab will be cleared and rebuilt. It only holds ' +
        'formulas, so nothing is lost. Your "' + STEALS_CONFIG.logSheet + '" rows are not touched.',
      ui.ButtonSet.OK_CANCEL);
    if (answer !== ui.Button.OK) return;
  }

  const log = steals_setupLog_(ss);
  summary = steals_setupSummary_(ss, log);

  ui.alert('Steals from the Future',
    'Ready. Add one row per steal (or payback) in "' + STEALS_CONFIG.logSheet + '". "' +
      STEALS_CONFIG.summarySheet + '" updates by itself.',
    ui.ButtonSet.OK);
  summary.activate();
}

/** Creates the log tab, or adds any missing columns to an existing one. Returns the sheet. */
function steals_setupLog_(ss) {
  const C = STEALS_CONFIG;
  let sheet = ss.getSheetByName(C.logSheet);
  if (!sheet) {
    sheet = ss.insertSheet(C.logSheet);
    sheet.getRange(1, 1, 1, C.logHeaders.length - 1)
      .setValues([C.logHeaders.slice(0, -1)]);
  } else {
    C.logHeaders.slice(0, -1).forEach(function (h) { ensureColumn(sheet, h); });
  }

  let col = headerIndexMap(sheet);
  const L = steals_letters_(col);

  // Month: one array formula in the header cell, so new rows fill themselves.
  const monthCol = 'Month' in col ? col['Month'] + 1 : sheet.getLastColumn() + 1;
  sheet.getRange(1, monthCol).setFormula(
    '={"Month"; ARRAYFORMULA(IF(ISNUMBER(' + L.Date + '2:' + L.Date + '), ' +
    'DATE(YEAR(' + L.Date + '2:' + L.Date + '), MONTH(' + L.Date + '2:' + L.Date + '), 1), ""))}');
  SpreadsheetApp.flush();
  col = headerIndexMap(sheet);

  const maxRows = sheet.getMaxRows();
  const body = function (h) { return sheet.getRange(2, col[h] + 1, maxRows - 1, 1); };

  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, sheet.getLastColumn()).setFontWeight('bold');

  body('Date').setNumberFormat(C.dateFormat).setDataValidation(
    SpreadsheetApp.newDataValidation().requireDate().setAllowInvalid(false)
      .setHelpText('A date, e.g. 09/11/2026').build());
  body('Direction').setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(C.directions, true).setAllowInvalid(false)
      .setHelpText('Steal = took from the future. Payback = put it back.').build());
  body('Type').setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(C.types, true).setAllowInvalid(false).build());
  body('Amount').setNumberFormat(C.moneyFormat).setDataValidation(
    SpreadsheetApp.newDataValidation().requireNumberGreaterThan(0).setAllowInvalid(false)
      .setHelpText('Rupiah, more than 0, without the fee.').build());
  body('Fee').setNumberFormat(C.moneyFormat).setDataValidation(
    SpreadsheetApp.newDataValidation().requireNumberGreaterThanOrEqualTo(0).setAllowInvalid(false)
      .setHelpText('Optional: cash advance fee, interest, redemption fee.').build());
  body('Month').setNumberFormat(C.monthFormat).setFontColor('#888888');
  sheet.getRange(1, col['Month'] + 1).setNote('Filled in from Date. Don\'t type in this column.');

  return sheet;
}

/** Clears and rebuilds the summary tab. Returns the sheet. */
function steals_setupSummary_(ss, log) {
  const C = STEALS_CONFIG;
  let sheet = ss.getSheetByName(C.summarySheet);
  if (sheet) {
    sheet.clear();
    sheet.clearConditionalFormatRules();
    sheet.getDataRange().clearDataValidations();
  } else {
    sheet = ss.insertSheet(C.summarySheet);
  }

  const R = C.firstDataRow;
  const f = steals_summaryFormulas_(steals_letters_(headerIndexMap(log)), R);
  const typeCount = C.types.length;
  const lastCol = 8 + typeCount;
  const need = Math.max(lastCol, 6);
  if (sheet.getMaxColumns() < need) sheet.insertColumnsAfter(sheet.getMaxColumns(), need - sheet.getMaxColumns());

  // ---- title + scoreboard ----
  sheet.getRange('A1').setValue('Steals from the Future')
    .setFontSize(14).setFontWeight('bold');
  sheet.getRange('C1').setValue('Goal: every month lower than the one before.')
    .setFontColor('#666666').setFontStyle('italic');
  sheet.getRange('A2:F2').setValues([[
    'This month', 'Last month', 'Status', 'Streak (months lower)', 'Owed to future (reserves)', 'Steals by month',
  ]]).setFontColor('#666666').setFontSize(9);
  sheet.getRange('A3:F3').setFormulas([[f.kpiThis, f.kpiLast, f.kpiStatus, f.kpiStreak, f.kpiOwed, f.kpiSpark]])
    .setFontSize(13).setFontWeight('bold');
  sheet.getRange('A3:B3').setNumberFormat(C.moneyFormat);
  sheet.getRange('D3').setNumberFormat('0');
  sheet.getRange('E3').setNumberFormat(C.moneyFormat);

  // ---- monthly table ----
  const headers = ['Month', 'Steals', 'vs Last Month', 'Trend', 'Paybacks', 'Net', 'Owed to Future', 'Fees']
    .concat(C.types);
  sheet.getRange(R - 1, 1, 1, headers.length).setValues([headers])
    .setFontWeight('bold').setBackground('#f1f3f4').setWrap(true);

  sheet.getRange(R - 1, 7).setNote(
    'Reserves taken and not put back yet, up to this month. Counts only: ' +
      C.reserveTypes.join(', ') + '. Credit card cash advances and paylater are left out.');

  const row = [f.month, f.steals, f.delta, f.trend, f.paybacks, f.net, f.owed, f.fees];
  for (let i = 0; i < typeCount; i++) row.push(f.byType(steals_colLetter_(9 + i)));
  sheet.getRange(R, 1, 1, row.length).setFormulas([row]);

  const rows = sheet.getMaxRows() - R + 1;
  sheet.getRange(R, 1, rows, 1).setNumberFormat(C.monthFormat);
  sheet.getRange(R, 2, rows, 1).setNumberFormat(C.moneyFormat);
  sheet.getRange(R, 3, rows, 1).setNumberFormat('+#,##0;-#,##0;0');
  sheet.getRange(R, 5, rows, lastCol - 4).setNumberFormat(C.moneyFormat);

  // ---- colours: lower is green, higher is red ----
  const trendRange = sheet.getRange(R, 4, rows, 1);
  const deltaRange = sheet.getRange(R, 3, rows, 1);
  const status = sheet.getRange('C3');
  const green = '#137333', greenBg = '#e6f4ea', red = '#c5221f', redBg = '#fce8e6';
  sheet.setConditionalFormatRules([
    SpreadsheetApp.newConditionalFormatRule().whenTextStartsWith('✓')
      .setFontColor(green).setBackground(greenBg).setRanges([trendRange, status]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextStartsWith('✗')
      .setFontColor(red).setBackground(redBg).setRanges([trendRange, status]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenNumberLessThan(0)
      .setFontColor(green).setRanges([deltaRange]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenNumberGreaterThan(0)
      .setFontColor(red).setRanges([deltaRange]).build(),
  ]);

  sheet.setFrozenRows(R - 1);
  sheet.setColumnWidth(1, 100);
  sheet.setColumnWidths(2, lastCol - 1, 115);
  sheet.setColumnWidth(4, 170);
  sheet.setColumnWidth(6, 160); // sparkline
  sheet.setRowHeight(R - 1, 36);
  sheet.setRowHeight(3, 40); // room for the sparkline
  return sheet;
}

/**
 * Builds every summary formula. `L` maps log header -> column letter; `R` is
 * the first data row of the monthly table. Pure (no Sheet calls), so it can
 * be tested outside Apps Script.
 */
function steals_summaryFormulas_(L, R) {
  const log = "'" + STEALS_CONFIG.logSheet + "'!";
  const rng = function (h) { return log + '$' + L[h] + '$2:$' + L[h]; };
  const amt = rng('Amount'), dir = rng('Direction'), mon = rng('Month'),
    typ = rng('Type'), fee = rng('Fee');
  const thisMonth = 'DATE(YEAR(TODAY()), MONTH(TODAY()), 1)';
  const col = function (c) { return c + R + ':' + c; };
  const A = col('A'), B = col('B'), C = col('C'), D = col('D'), E = col('E');
  const reserves = '{' + STEALS_CONFIG.reserveTypes.map(function (t) {
    return '"' + t.replace(/"/g, '""') + '"';
  }).join(', ') + '}';
  // Reserve-type total for a direction, optionally only up to month m.
  const reserveSum = function (direction, m) {
    return 'SUM(SUMIFS(' + amt + (m ? ', ' + mon + ', "<=" & ' + m : '') + ', ' +
      dir + ', "' + direction + '", ' + typ + ', ' + reserves + '))';
  };
  const stealsIn = function (m) { return 'SUMIFS(' + amt + ', ' + mon + ', ' + m + ', ' + dir + ', "Steal")'; };

  return {
    // Every month from the first logged one to the later of now and the last logged one.
    month:
      '=IFERROR(LET(m, FILTER(' + mon + ', ISNUMBER(' + mon + ')), s, MIN(m), ' +
      'e, MAX(MAX(m), ' + thisMonth + '), ' +
      'n, (YEAR(e) - YEAR(s)) * 12 + MONTH(e) - MONTH(s) + 1, ' +
      'DATE(YEAR(s), MONTH(s) + SEQUENCE(n) - 1, 1)), "")',
    steals: '=MAP(' + A + ', LAMBDA(m, IF(m = "", "", ' + stealsIn('m') + ')))',
    delta:
      '=MAP(' + A + ', ' + B + ', LAMBDA(m, b, IF(OR(m = "", m = $A$' + R + '), "", ' +
      'b - ' + stealsIn('EDATE(m, -1)') + ')))',
    trend:
      '=MAP(' + A + ', ' + B + ', ' + C + ', LAMBDA(m, b, d, IF(m = "", "", ' +
      'IF(b = 0, "✓ Zero", IF(d = "", "— First month", ' +
      'IF(m = ' + thisMonth + ', IF(d < 0, "✓ On track", "✗ Already ≥ last month"), ' +
      'IF(d < 0, "✓ Lower", "✗ Not lower")))))))',
    paybacks:
      '=MAP(' + A + ', LAMBDA(m, IF(m = "", "", SUMIFS(' + amt + ', ' + mon + ', m, ' + dir + ', "Payback"))))',
    net: '=MAP(' + A + ', ' + B + ', ' + E + ', LAMBDA(m, b, p, IF(m = "", "", b - p)))',
    owed:
      '=MAP(' + A + ', LAMBDA(m, IF(m = "", "", ' +
      reserveSum('Steal', 'm') + ' - ' + reserveSum('Payback', 'm') + ')))',
    fees: '=MAP(' + A + ', LAMBDA(m, IF(m = "", "", SUMIFS(' + fee + ', ' + mon + ', m))))',
    byType: function (c) {
      return '=MAP(' + A + ', LAMBDA(m, IF(m = "", "", SUMIFS(' + amt + ', ' + mon + ', m, ' +
        dir + ', "Steal", ' + typ + ', ' + c + '$' + (R - 1) + '))))';
    },

    kpiThis: '=' + stealsIn(thisMonth),
    kpiLast: '=' + stealsIn('EDATE(' + thisMonth + ', -1)'),
    kpiStatus: '=IFERROR(XLOOKUP(' + thisMonth + ', ' + A + ', ' + D + '), "—")',
    // Trailing run of finished months whose Trend starts with ✓.
    kpiStreak:
      '=IFERROR(LET(t, FILTER(' + D + ', ISNUMBER(' + A + '), ' + A + ' < ' + thisMonth + '), ' +
      'n, ROWS(t), IFERROR(n - MAX(FILTER(SEQUENCE(n), LEFT(t, 1) <> "✓")), n)), 0)',
    kpiOwed: '=' + reserveSum('Steal') + ' - ' + reserveSum('Payback'),
    kpiSpark:
      '=IFERROR(SPARKLINE(FILTER(' + B + ', ISNUMBER(' + A + ')), ' +
      '{"charttype", "column"; "color", "#c5221f"}), "")',
  };
}

/** Header -> column letter for the log's columns. Throws if one is missing. */
function steals_letters_(col) {
  const out = {};
  STEALS_CONFIG.logHeaders.forEach(function (h) {
    if (h === 'Month' && !(h in col)) return; // set up right after this call
    if (!(h in col)) throw new Error('"' + STEALS_CONFIG.logSheet + '" is missing the "' + h + '" column.');
    out[h] = steals_colLetter_(col[h] + 1);
  });
  return out;
}

/** 1-based column number -> letter(s): 1 -> A, 27 -> AA. */
function steals_colLetter_(n) {
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}
